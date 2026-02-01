#!/usr/bin/env python3
"""Benchmark all 4 RLWE audit circuit variants:
  1. const PK + e as witness
  2. var PK + e as witness
  3. const PK + e computed (no e witness)
  4. var PK + e computed (no e witness)

All use q=167772161, Delta=655360, MSG_SLOTS=64, N=1024.
"""
import os
import subprocess
import random
import re
import json
import math
import time
import shutil

N = 1024
RLWE_Q = 167772161
PLAINTEXT_MOD = 256
DELTA = RLWE_Q // PLAINTEXT_MOD  # 655360
MSG_SLOTS = 64
PACKED_C0 = math.ceil(MSG_SLOTS / 7)
PACKED_C1 = math.ceil(N / 7)
TOTAL_PACKED = PACKED_C0 + PACKED_C1
BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJ_DIR = os.path.dirname(BASE_DIR)
KEYS_DIR = os.path.join(PROJ_DIR, "demo-frontend", "public", "rlwe")
NARGO = os.path.expanduser("~/.nargo/bin/nargo")
SUNSPOT = os.path.expanduser("~/gopath/bin/sunspot")


def negacyclic_mul_mod_q(a, b, n, q):
    result = [0] * n
    for i in range(n):
        for j in range(n):
            idx = i + j
            if idx < n:
                result[idx] = (result[idx] + a[i] * b[j]) % q
            else:
                result[idx - n] = (result[idx - n] - a[i] * b[j]) % q
    return result


def negacyclic_matrix_row_mod_q(poly, k, n, q):
    row = [0] * n
    for j in range(n):
        idx = k - j
        if idx >= 0:
            row[j] = poly[idx] % q
        else:
            row[j] = (-poly[idx + n]) % q
    return row


def encode_field_to_bytes(value, num_bytes=32):
    slots = []
    for i in range(num_bytes):
        slots.append((value >> (i * 8)) & 0xFF)
    return slots


def format_field(v):
    v = v % BN254_P
    if v == 0:
        return '"0"'
    return f'"0x{v:064x}"'


def format_field_noir(v):
    v = v % BN254_P
    if v == 0:
        return '0'
    return f'0x{v:064x}'


def load_rlwe_pk():
    pk_path = os.path.join(KEYS_DIR, "rlwe_pk.json")
    with open(pk_path) as f:
        data = json.load(f)
    a = [int(v, 16) for v in data["a"]]
    b = [int(v, 16) for v in data["b"]]
    return a, b


def run_bjj_helper_poseidon1(secret_key):
    helper_dir = os.path.join(PROJ_DIR, "bjj_helper_p1")
    os.makedirs(os.path.join(helper_dir, "src"), exist_ok=True)

    with open(os.path.join(helper_dir, "Nargo.toml"), "w") as f:
        f.write("""[package]
name = "bjj_helper_p1"
type = "bin"
authors = [""]
compiler_version = ">=0.39.0"

[dependencies]
poseidon = { tag = "v0.1.1", git = "https://github.com/noir-lang/poseidon" }
""")

    with open(os.path.join(helper_dir, "src", "main.nr"), "w") as f:
        f.write("""use dep::poseidon::poseidon::bn254::hash_2 as poseidon_hash;
use std::embedded_curve_ops::{EmbeddedCurveScalar, fixed_base_scalar_mul};

fn main(secret_key: Field) -> pub (Field, Field, Field) {
    let two_pow_128: Field = 0x100000000000000000000000000000000;
    let secret_low = secret_key as u128;
    let secret_high = ((secret_key - secret_low as Field) / two_pow_128) as u128;
    let scalar = EmbeddedCurveScalar::new(secret_low as Field, secret_high as Field);
    let pk = fixed_base_scalar_mul(scalar);
    let wa = poseidon_hash([pk.x, pk.y]);
    (pk.x, pk.y, wa)
}
""")

    with open(os.path.join(helper_dir, "Prover.toml"), "w") as f:
        f.write(f'secret_key = "{secret_key}"\n')

    subprocess.run([NARGO, "compile"], cwd=helper_dir, check=True, capture_output=True)
    result = subprocess.run([NARGO, "execute"], cwd=helper_dir, check=True, capture_output=True, text=True)
    output = result.stdout + result.stderr

    match = re.search(r'Circuit output:\s*\((0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+)\)', output)
    if not match:
        raise RuntimeError(f"Could not parse bjj_helper_p1 output: {output}")

    return int(match.group(1), 16), int(match.group(2), 16), int(match.group(3), 16)


def run_ct_helper_v2(c0_sparse, c1):
    helper_dir = os.path.join(PROJ_DIR, "ct_helper_v2")
    os.makedirs(os.path.join(helper_dir, "src"), exist_ok=True)

    with open(os.path.join(helper_dir, "Nargo.toml"), "w") as f:
        f.write("""[package]
name = "ct_helper_v2"
type = "bin"
authors = [""]
compiler_version = ">=0.39.0"

[dependencies]
""")

    with open(os.path.join(helper_dir, "src", "main.nr"), "w") as f:
        f.write(f"""use std::hash::poseidon2_permutation;

global N: u32 = {N};
global MSG_SLOTS: u32 = {MSG_SLOTS};
global PACKED_C0: u32 = {PACKED_C0};
global PACKED_C1: u32 = {PACKED_C1};
global TOTAL_PACKED: u32 = {TOTAL_PACKED};

fn pack_7_from_sparse(arr: [Field; MSG_SLOTS], offset: u32) -> Field {{
    let mut packed: Field = 0;
    let mut shift: Field = 1;
    for j in 0..7 {{
        if offset + j < MSG_SLOTS {{
            packed += arr[offset + j] * shift;
        }}
        shift *= 0x100000000;
    }}
    packed
}}

fn pack_7_from_full(arr: [Field; N], offset: u32) -> Field {{
    let mut packed: Field = 0;
    let mut shift: Field = 1;
    for j in 0..7 {{
        if offset + j < N {{
            packed += arr[offset + j] * shift;
        }}
        shift *= 0x100000000;
    }}
    packed
}}

fn main(c0_sparse: [Field; MSG_SLOTS], c1: [Field; N]) -> pub Field {{
    let mut packed: [Field; TOTAL_PACKED] = [0; TOTAL_PACKED];
    for i in 0..PACKED_C0 {{
        packed[i] = pack_7_from_sparse(c0_sparse, i * 7);
    }}
    for i in 0..PACKED_C1 {{
        packed[PACKED_C0 + i] = pack_7_from_full(c1, i * 7);
    }}

    let mut state: [Field; 4] = [0; 4];
    let full_rounds: u32 = TOTAL_PACKED / 3;
    for i in 0..full_rounds {{
        state[0] += packed[3 * i];
        state[1] += packed[3 * i + 1];
        state[2] += packed[3 * i + 2];
        state = poseidon2_permutation(state, 4);
    }}
    let remainder = TOTAL_PACKED - full_rounds * 3;
    if remainder >= 1 {{
        state[0] += packed[full_rounds * 3];
    }}
    if remainder >= 2 {{
        state[1] += packed[full_rounds * 3 + 1];
    }}
    state = poseidon2_permutation(state, 4);
    state[0]
}}
""")

    with open(os.path.join(helper_dir, "Prover.toml"), "w") as f:
        f.write(f"c0_sparse = [{', '.join(format_field(v) for v in c0_sparse)}]\n")
        f.write(f"c1 = [{', '.join(format_field(v) for v in c1)}]\n")

    subprocess.run([NARGO, "compile"], cwd=helper_dir, check=True, capture_output=True)
    result = subprocess.run([NARGO, "execute"], cwd=helper_dir, check=True, capture_output=True, text=True)
    output = result.stdout + result.stderr

    match = re.search(r'Circuit output:\s*(0x[0-9a-fA-F]+)', output)
    if not match:
        raise RuntimeError(f"Could not parse ct_helper_v2 output: {output}")

    return int(match.group(1), 16)


# ============================================================
# Circuit generation functions for 4 variants
# ============================================================

def circuit_common_header():
    return f"""use dep::poseidon::poseidon::bn254::hash_2 as poseidon1_hash_2;
use std::hash::poseidon2_permutation;
use std::embedded_curve_ops::{{EmbeddedCurveScalar, fixed_base_scalar_mul}};

global N: u32 = {N};
global MSG_SLOTS: u32 = {MSG_SLOTS};
global PACKED_C0: u32 = {PACKED_C0};
global PACKED_C1: u32 = {PACKED_C1};
global TOTAL_PACKED: u32 = {TOTAL_PACKED};
global RLWE_Q: Field = {RLWE_Q};
global DELTA: Field = {DELTA};
"""


def circuit_helper_fns():
    return f"""
fn inner_product(a: [Field; N], b: [Field; N]) -> Field {{
    let mut sum: Field = 0;
    for i in 0..N {{ sum += a[i] * b[i]; }}
    sum
}}

fn pack_7_from_sparse(arr: [Field; MSG_SLOTS], offset: u32) -> Field {{
    let mut packed: Field = 0;
    let mut shift: Field = 1;
    for j in 0..7 {{
        if offset + j < MSG_SLOTS {{
            packed += arr[offset + j] * shift;
        }}
        shift *= 0x100000000;
    }}
    packed
}}

fn pack_7_from_full(arr: [Field; N], offset: u32) -> Field {{
    let mut packed: Field = 0;
    let mut shift: Field = 1;
    for j in 0..7 {{
        if offset + j < N {{
            packed += arr[offset + j] * shift;
        }}
        shift *= 0x100000000;
    }}
    packed
}}

fn compute_ct_commitment_packed(c0_sparse: [Field; MSG_SLOTS], c1: [Field; N]) -> Field {{
    let mut packed: [Field; TOTAL_PACKED] = [0; TOTAL_PACKED];
    for i in 0..PACKED_C0 {{
        packed[i] = pack_7_from_sparse(c0_sparse, i * 7);
    }}
    for i in 0..PACKED_C1 {{
        packed[PACKED_C0 + i] = pack_7_from_full(c1, i * 7);
    }}

    let mut state: [Field; 4] = [0; 4];
    let full_rounds: u32 = TOTAL_PACKED / 3;
    for i in 0..full_rounds {{
        state[0] += packed[3 * i];
        state[1] += packed[3 * i + 1];
        state[2] += packed[3 * i + 2];
        state = poseidon2_permutation(state, 4);
    }}
    let remainder = TOTAL_PACKED - full_rounds * 3;
    if remainder >= 1 {{
        state[0] += packed[full_rounds * 3];
    }}
    if remainder >= 2 {{
        state[1] += packed[full_rounds * 3 + 1];
    }}
    state = poseidon2_permutation(state, 4);
    state[0]
}}

fn encode_field_to_byte_slots(value: Field) -> [Field; 32] {{
    let bits: [u1; 254] = value.to_le_bits();
    let mut slots: [Field; 32] = [0; 32];
    for i in 0..32 {{
        let mut slot_value: Field = 0;
        let mut power: Field = 1;
        let start = i * 8;
        for j in 0..8 {{
            let bit_index = start + j;
            if bit_index < 254 {{
                if bits[bit_index] == 1 {{
                    slot_value = slot_value + power;
                }}
            }}
            power = power * 2;
        }}
        slots[i] = slot_value;
    }}
    slots
}}

fn range_proof_signed(value: Field) {{
    let shifted = value + 128;
    let _ = shifted as u8;
}}
"""


def gen_circuit_const_e_witness(pk_b_rows, pk_a_rows):
    """Variant 1: const PK, e1/e2 as witness"""
    pk_b_block = ',\n'.join(
        f"    [{', '.join(format_field_noir(v) for v in row)}]" for row in pk_b_rows)
    pk_a_block = ',\n'.join(
        f"    [{', '.join(format_field_noir(v) for v in row)}]" for row in pk_a_rows)

    return f"""// Variant 1: const PK + e as witness
{circuit_common_header()}

global PK_B_ROWS: [[Field; N]; MSG_SLOTS] = [
{pk_b_block}
];

global PK_A_ROWS: [[Field; N]; N] = [
{pk_a_block}
];

{circuit_helper_fns()}

fn main(
    wa_commitment: pub Field,
    ct_commitment: pub Field,
    c0_sparse: pub [Field; MSG_SLOTS],
    c1: pub [Field; N],
    secret_key: Field,
    r: [Field; N],
    e1_sparse: [Field; MSG_SLOTS],
    e2: [Field; N],
    k0: [Field; MSG_SLOTS],
    k1: [Field; N],
) {{
    let two_pow_128: Field = 0x100000000000000000000000000000000;
    let secret_low = secret_key as u128;
    let secret_high = ((secret_key - secret_low as Field) / two_pow_128) as u128;
    let scalar = EmbeddedCurveScalar::new(secret_low as Field, secret_high as Field);
    let pk = fixed_base_scalar_mul(scalar);

    let calculated_wa = poseidon1_hash_2([pk.x, pk.y]);
    assert(wa_commitment == calculated_wa);

    let mut msg: [Field; MSG_SLOTS] = [0; MSG_SLOTS];
    let slots_x = encode_field_to_byte_slots(pk.x);
    for i in 0..32 {{ msg[i] = slots_x[i]; }}
    let slots_y = encode_field_to_byte_slots(pk.y);
    for i in 0..32 {{ msg[32 + i] = slots_y[i]; }}

    for i in 0..N {{ range_proof_signed(r[i]); }}
    for i in 0..MSG_SLOTS {{ range_proof_signed(e1_sparse[i]); }}
    for i in 0..N {{ range_proof_signed(e2[i]); }}

    for i in 0..MSG_SLOTS {{
        let ip = inner_product(PK_B_ROWS[i], r);
        assert(c0_sparse[i] + k0[i] * RLWE_Q == ip + e1_sparse[i] + DELTA * msg[i]);
    }}

    for i in 0..N {{
        let ip = inner_product(PK_A_ROWS[i], r);
        assert(c1[i] + k1[i] * RLWE_Q == ip + e2[i]);
    }}

    let calculated_ct = compute_ct_commitment_packed(c0_sparse, c1);
    assert(ct_commitment == calculated_ct);
}}
"""


def gen_circuit_var_e_witness():
    """Variant 2: var PK (passed as witness), e1/e2 as witness"""
    return f"""// Variant 2: var PK + e as witness
{circuit_common_header()}

{circuit_helper_fns()}

fn main(
    wa_commitment: pub Field,
    ct_commitment: pub Field,
    c0_sparse: pub [Field; MSG_SLOTS],
    c1: pub [Field; N],
    secret_key: Field,
    r: [Field; N],
    e1_sparse: [Field; MSG_SLOTS],
    e2: [Field; N],
    k0: [Field; MSG_SLOTS],
    k1: [Field; N],
    pk_b_rows: [[Field; N]; MSG_SLOTS],
    pk_a_rows: [[Field; N]; N],
) {{
    let two_pow_128: Field = 0x100000000000000000000000000000000;
    let secret_low = secret_key as u128;
    let secret_high = ((secret_key - secret_low as Field) / two_pow_128) as u128;
    let scalar = EmbeddedCurveScalar::new(secret_low as Field, secret_high as Field);
    let pk = fixed_base_scalar_mul(scalar);

    let calculated_wa = poseidon1_hash_2([pk.x, pk.y]);
    assert(wa_commitment == calculated_wa);

    let mut msg: [Field; MSG_SLOTS] = [0; MSG_SLOTS];
    let slots_x = encode_field_to_byte_slots(pk.x);
    for i in 0..32 {{ msg[i] = slots_x[i]; }}
    let slots_y = encode_field_to_byte_slots(pk.y);
    for i in 0..32 {{ msg[32 + i] = slots_y[i]; }}

    for i in 0..N {{ range_proof_signed(r[i]); }}
    for i in 0..MSG_SLOTS {{ range_proof_signed(e1_sparse[i]); }}
    for i in 0..N {{ range_proof_signed(e2[i]); }}

    for i in 0..MSG_SLOTS {{
        let ip = inner_product(pk_b_rows[i], r);
        assert(c0_sparse[i] + k0[i] * RLWE_Q == ip + e1_sparse[i] + DELTA * msg[i]);
    }}

    for i in 0..N {{
        let ip = inner_product(pk_a_rows[i], r);
        assert(c1[i] + k1[i] * RLWE_Q == ip + e2[i]);
    }}

    let calculated_ct = compute_ct_commitment_packed(c0_sparse, c1);
    assert(ct_commitment == calculated_ct);
}}
"""


def gen_circuit_const_e_computed(pk_b_rows, pk_a_rows):
    """Variant 3: const PK, e computed inside circuit (no e witness)"""
    pk_b_block = ',\n'.join(
        f"    [{', '.join(format_field_noir(v) for v in row)}]" for row in pk_b_rows)
    pk_a_block = ',\n'.join(
        f"    [{', '.join(format_field_noir(v) for v in row)}]" for row in pk_a_rows)

    return f"""// Variant 3: const PK + e computed (no e witness)
{circuit_common_header()}

global PK_B_ROWS: [[Field; N]; MSG_SLOTS] = [
{pk_b_block}
];

global PK_A_ROWS: [[Field; N]; N] = [
{pk_a_block}
];

{circuit_helper_fns()}

fn main(
    wa_commitment: pub Field,
    ct_commitment: pub Field,
    c0_sparse: pub [Field; MSG_SLOTS],
    c1: pub [Field; N],
    secret_key: Field,
    r: [Field; N],
    k0: [Field; MSG_SLOTS],
    k1: [Field; N],
) {{
    let two_pow_128: Field = 0x100000000000000000000000000000000;
    let secret_low = secret_key as u128;
    let secret_high = ((secret_key - secret_low as Field) / two_pow_128) as u128;
    let scalar = EmbeddedCurveScalar::new(secret_low as Field, secret_high as Field);
    let pk = fixed_base_scalar_mul(scalar);

    let calculated_wa = poseidon1_hash_2([pk.x, pk.y]);
    assert(wa_commitment == calculated_wa);

    let mut msg: [Field; MSG_SLOTS] = [0; MSG_SLOTS];
    let slots_x = encode_field_to_byte_slots(pk.x);
    for i in 0..32 {{ msg[i] = slots_x[i]; }}
    let slots_y = encode_field_to_byte_slots(pk.y);
    for i in 0..32 {{ msg[32 + i] = slots_y[i]; }}

    for i in 0..N {{ range_proof_signed(r[i]); }}

    // e1 computed from public values + quotient witness, then range-checked
    for i in 0..MSG_SLOTS {{
        let ip = inner_product(PK_B_ROWS[i], r);
        let e1_i = c0_sparse[i] + k0[i] * RLWE_Q - ip - DELTA * msg[i];
        range_proof_signed(e1_i);
    }}

    // e2 computed from public values + quotient witness, then range-checked
    for i in 0..N {{
        let ip = inner_product(PK_A_ROWS[i], r);
        let e2_i = c1[i] + k1[i] * RLWE_Q - ip;
        range_proof_signed(e2_i);
    }}

    let calculated_ct = compute_ct_commitment_packed(c0_sparse, c1);
    assert(ct_commitment == calculated_ct);
}}
"""


def gen_circuit_var_e_computed():
    """Variant 4: var PK, e computed inside circuit (no e witness)"""
    return f"""// Variant 4: var PK + e computed (no e witness)
{circuit_common_header()}

{circuit_helper_fns()}

fn main(
    wa_commitment: pub Field,
    ct_commitment: pub Field,
    c0_sparse: pub [Field; MSG_SLOTS],
    c1: pub [Field; N],
    secret_key: Field,
    r: [Field; N],
    k0: [Field; MSG_SLOTS],
    k1: [Field; N],
    pk_b_rows: [[Field; N]; MSG_SLOTS],
    pk_a_rows: [[Field; N]; N],
) {{
    let two_pow_128: Field = 0x100000000000000000000000000000000;
    let secret_low = secret_key as u128;
    let secret_high = ((secret_key - secret_low as Field) / two_pow_128) as u128;
    let scalar = EmbeddedCurveScalar::new(secret_low as Field, secret_high as Field);
    let pk = fixed_base_scalar_mul(scalar);

    let calculated_wa = poseidon1_hash_2([pk.x, pk.y]);
    assert(wa_commitment == calculated_wa);

    let mut msg: [Field; MSG_SLOTS] = [0; MSG_SLOTS];
    let slots_x = encode_field_to_byte_slots(pk.x);
    for i in 0..32 {{ msg[i] = slots_x[i]; }}
    let slots_y = encode_field_to_byte_slots(pk.y);
    for i in 0..32 {{ msg[32 + i] = slots_y[i]; }}

    for i in 0..N {{ range_proof_signed(r[i]); }}

    for i in 0..MSG_SLOTS {{
        let ip = inner_product(pk_b_rows[i], r);
        let e1_i = c0_sparse[i] + k0[i] * RLWE_Q - ip - DELTA * msg[i];
        range_proof_signed(e1_i);
    }}

    for i in 0..N {{
        let ip = inner_product(pk_a_rows[i], r);
        let e2_i = c1[i] + k1[i] * RLWE_Q - ip;
        range_proof_signed(e2_i);
    }}

    let calculated_ct = compute_ct_commitment_packed(c0_sparse, c1);
    assert(ct_commitment == calculated_ct);
}}
"""


def write_prover_toml(path, data, include_e, include_pk_rows, pk_b_rows=None, pk_a_rows=None):
    """Write Prover.toml for a variant."""
    with open(path, "w") as f:
        f.write(f"secret_key = {format_field(data['secret_key'])}\n")
        f.write(f"wa_commitment = {format_field(data['wa_commitment'])}\n")
        f.write(f"ct_commitment = {format_field(data['ct_commitment'])}\n")
        f.write(f"c0_sparse = [{', '.join(format_field(v) for v in data['c0_sparse'])}]\n")
        f.write(f"c1 = [{', '.join(format_field(v) for v in data['c1'])}]\n")
        f.write(f"r = [{', '.join(format_field(v) for v in data['r_signed'])}]\n")
        if include_e:
            f.write(f"e1_sparse = [{', '.join(format_field(v) for v in data['e1_signed'])}]\n")
            f.write(f"e2 = [{', '.join(format_field(v) for v in data['e2_signed'])}]\n")
        f.write(f"k0 = [{', '.join(format_field(v) for v in data['k0'])}]\n")
        f.write(f"k1 = [{', '.join(format_field(v) for v in data['k1'])}]\n")
        if include_pk_rows:
            # Write pk_b_rows as 2D array
            f.write("pk_b_rows = [\n")
            for row in pk_b_rows:
                f.write(f"  [{', '.join(format_field(v) for v in row)}],\n")
            f.write("]\n")
            f.write("pk_a_rows = [\n")
            for row in pk_a_rows:
                f.write(f"  [{', '.join(format_field(v) for v in row)}],\n")
            f.write("]\n")


def run_benchmark(variant_name, circuit_dir, try_prove=True):
    """Run nargo compile + execute + sunspot pipeline, return metrics."""
    metrics = {"name": variant_name}

    # nargo compile
    print(f"  nargo compile...")
    t0 = time.time()
    result = subprocess.run([NARGO, "compile"], cwd=circuit_dir, check=True,
                           capture_output=True, text=True)
    metrics["compile_time"] = time.time() - t0
    print(f"  nargo compile: {metrics['compile_time']:.1f}s")

    # nargo execute
    print(f"  nargo execute...")
    t0 = time.time()
    subprocess.run([NARGO, "execute"], cwd=circuit_dir, check=True, capture_output=True)
    metrics["execute_time"] = time.time() - t0
    print(f"  nargo execute: {metrics['execute_time']:.1f}s")

    # Get circuit size from ACIR
    target_dir = os.path.join(circuit_dir, "target")
    acir_file = None
    for fname in os.listdir(target_dir):
        if fname.endswith(".json"):
            acir_file = os.path.join(target_dir, fname)
            break

    witness_file = acir_file.replace(".json", ".gz")
    metrics["acir_size"] = os.path.getsize(acir_file) / 1024
    metrics["witness_size"] = os.path.getsize(witness_file) / 1024

    # Get main.nr size
    main_nr = os.path.join(circuit_dir, "src", "main.nr")
    metrics["circuit_file_size"] = os.path.getsize(main_nr) / 1024 / 1024

    # Prover.toml size
    prover_toml = os.path.join(circuit_dir, "Prover.toml")
    metrics["prover_toml_size"] = os.path.getsize(prover_toml) / 1024

    if not try_prove:
        # Just do sunspot compile for constraint count
        print(f"  sunspot compile (constraints only)...")
        result = subprocess.run([SUNSPOT, "compile", acir_file], check=True,
                               capture_output=True, text=True)
        output = result.stdout + result.stderr
        match = re.search(r'nbConstraints=(\d+)', output)
        if match:
            metrics["constraints"] = int(match.group(1))
        ccs_file = acir_file.replace(".json", ".ccs")
        metrics["ccs_size"] = os.path.getsize(ccs_file) / 1024 / 1024
        metrics["prove_time"] = None
        metrics["proof_size"] = None
        metrics["verify_time"] = None
        metrics["pk_size"] = None
        return metrics

    # sunspot compile
    print(f"  sunspot compile...")
    t0 = time.time()
    result = subprocess.run([SUNSPOT, "compile", acir_file], check=True,
                           capture_output=True, text=True)
    output = result.stdout + result.stderr
    metrics["sunspot_compile_time"] = time.time() - t0
    match = re.search(r'nbConstraints=(\d+)', output)
    if match:
        metrics["constraints"] = int(match.group(1))
    ccs_file = acir_file.replace(".json", ".ccs")
    metrics["ccs_size"] = os.path.getsize(ccs_file) / 1024 / 1024

    # sunspot setup
    print(f"  sunspot setup...")
    t0 = time.time()
    subprocess.run([SUNSPOT, "setup", ccs_file], check=True, capture_output=True)
    metrics["setup_time"] = time.time() - t0
    pk_file = ccs_file.replace(".ccs", ".pk")
    vk_file = ccs_file.replace(".ccs", ".vk")
    metrics["pk_size"] = os.path.getsize(pk_file) / 1024 / 1024

    # sunspot prove
    print(f"  sunspot prove...")
    t0 = time.time()
    try:
        subprocess.run([SUNSPOT, "prove", acir_file, witness_file, ccs_file, pk_file],
                      check=True, capture_output=True, text=True)
        metrics["prove_time"] = time.time() - t0
        proof_file = ccs_file.replace(".ccs", ".proof")
        pw_file = ccs_file.replace(".ccs", ".pw")
        metrics["proof_size"] = os.path.getsize(proof_file)

        # sunspot verify
        print(f"  sunspot verify...")
        t0 = time.time()
        subprocess.run([SUNSPOT, "verify", vk_file, proof_file, pw_file],
                      check=True, capture_output=True)
        metrics["verify_time"] = time.time() - t0
    except subprocess.CalledProcessError as e:
        print(f"  sunspot prove FAILED: {e}")
        metrics["prove_time"] = None
        metrics["proof_size"] = None
        metrics["verify_time"] = None

    return metrics


def main():
    rng = random.Random(999)
    secret_key = 12345

    # Load PK
    print("=== Loading RLWE PK ===")
    rlwe_pk_a, rlwe_pk_b = load_rlwe_pk()

    # BJJ
    print("=== BJJ helper ===")
    owner_x, owner_y, wa_commitment = run_bjj_helper_poseidon1(secret_key)

    # Encode + encrypt
    print("=== Encode & encrypt ===")
    msg = [0] * MSG_SLOTS
    for i in range(32):
        msg[i] = encode_field_to_bytes(owner_x, 32)[i]
    for i in range(32):
        msg[32 + i] = encode_field_to_bytes(owner_y, 32)[i]

    r_signed = [rng.randint(-3, 3) for _ in range(N)]
    e1_signed = [rng.randint(-3, 3) for _ in range(MSG_SLOTS)]
    e2_signed = [rng.randint(-3, 3) for _ in range(N)]

    r_mod_q = [v % RLWE_Q for v in r_signed]
    e1_mod_q = [v % RLWE_Q for v in e1_signed]
    e2_mod_q = [v % RLWE_Q for v in e2_signed]

    br = negacyclic_mul_mod_q(rlwe_pk_b, r_mod_q, N, RLWE_Q)
    c0_sparse = [(br[i] + e1_mod_q[i] + DELTA * msg[i]) % RLWE_Q for i in range(MSG_SLOTS)]

    ar = negacyclic_mul_mod_q(rlwe_pk_a, r_mod_q, N, RLWE_Q)
    c1 = [(ar[i] + e2_mod_q[i]) % RLWE_Q for i in range(N)]

    # Quotients
    pk_b_rows = [negacyclic_matrix_row_mod_q(rlwe_pk_b, k, N, RLWE_Q) for k in range(MSG_SLOTS)]
    pk_a_rows = [negacyclic_matrix_row_mod_q(rlwe_pk_a, k, N, RLWE_Q) for k in range(N)]

    k0_list = []
    for i in range(MSG_SLOTS):
        ip_int = sum(pk_b_rows[i][j] * r_signed[j] for j in range(N))
        full_val = ip_int + e1_signed[i] + DELTA * msg[i]
        k, rem = divmod_with_remainder(full_val, RLWE_Q)
        assert rem == c0_sparse[i]
        k0_list.append(k)

    k1_list = []
    for i in range(N):
        ip_int = sum(pk_a_rows[i][j] * r_signed[j] for j in range(N))
        full_val = ip_int + e2_signed[i]
        k, rem = divmod_with_remainder(full_val, RLWE_Q)
        assert rem == c1[i]
        k1_list.append(k)

    # ct_commitment
    print("=== ct_commitment ===")
    ct_commitment = run_ct_helper_v2(c0_sparse, c1)

    witness_data = {
        "secret_key": secret_key,
        "wa_commitment": wa_commitment,
        "ct_commitment": ct_commitment,
        "c0_sparse": c0_sparse,
        "c1": c1,
        "r_signed": r_signed,
        "e1_signed": e1_signed,
        "e2_signed": e2_signed,
        "k0": k0_list,
        "k1": k1_list,
    }

    all_results = []

    # ============================================================
    # Variant 1: const PK + e witness
    # ============================================================
    variant = "const_pk_e_witness"
    print(f"\n{'='*60}")
    print(f"Variant 1: {variant}")
    print(f"{'='*60}")
    circuit_dir = os.path.join(PROJ_DIR, f"bench_{variant}")
    os.makedirs(os.path.join(circuit_dir, "src"), exist_ok=True)
    shutil.rmtree(os.path.join(circuit_dir, "target"), ignore_errors=True)

    with open(os.path.join(circuit_dir, "Nargo.toml"), "w") as f:
        f.write(f"""[package]
name = "{variant}"
type = "bin"
authors = [""]
compiler_version = ">=0.39.0"

[dependencies]
poseidon = {{ tag = "v0.1.1", git = "https://github.com/noir-lang/poseidon" }}
""")

    circuit_code = gen_circuit_const_e_witness(pk_b_rows, pk_a_rows)
    with open(os.path.join(circuit_dir, "src", "main.nr"), "w") as f:
        f.write(circuit_code)
    write_prover_toml(os.path.join(circuit_dir, "Prover.toml"), witness_data,
                      include_e=True, include_pk_rows=False)
    metrics = run_benchmark(variant, circuit_dir, try_prove=True)
    all_results.append(metrics)

    # ============================================================
    # Variant 2: var PK + e witness
    # ============================================================
    variant = "var_pk_e_witness"
    print(f"\n{'='*60}")
    print(f"Variant 2: {variant}")
    print(f"{'='*60}")
    circuit_dir = os.path.join(PROJ_DIR, f"bench_{variant}")
    os.makedirs(os.path.join(circuit_dir, "src"), exist_ok=True)
    shutil.rmtree(os.path.join(circuit_dir, "target"), ignore_errors=True)

    with open(os.path.join(circuit_dir, "Nargo.toml"), "w") as f:
        f.write(f"""[package]
name = "{variant}"
type = "bin"
authors = [""]
compiler_version = ">=0.39.0"

[dependencies]
poseidon = {{ tag = "v0.1.1", git = "https://github.com/noir-lang/poseidon" }}
""")

    circuit_code = gen_circuit_var_e_witness()
    with open(os.path.join(circuit_dir, "src", "main.nr"), "w") as f:
        f.write(circuit_code)
    write_prover_toml(os.path.join(circuit_dir, "Prover.toml"), witness_data,
                      include_e=True, include_pk_rows=True,
                      pk_b_rows=pk_b_rows, pk_a_rows=pk_a_rows)
    metrics = run_benchmark(variant, circuit_dir, try_prove=True)
    all_results.append(metrics)

    # ============================================================
    # Variant 3: const PK + e computed
    # ============================================================
    variant = "const_pk_e_computed"
    print(f"\n{'='*60}")
    print(f"Variant 3: {variant}")
    print(f"{'='*60}")
    circuit_dir = os.path.join(PROJ_DIR, f"bench_{variant}")
    os.makedirs(os.path.join(circuit_dir, "src"), exist_ok=True)
    shutil.rmtree(os.path.join(circuit_dir, "target"), ignore_errors=True)

    with open(os.path.join(circuit_dir, "Nargo.toml"), "w") as f:
        f.write(f"""[package]
name = "{variant}"
type = "bin"
authors = [""]
compiler_version = ">=0.39.0"

[dependencies]
poseidon = {{ tag = "v0.1.1", git = "https://github.com/noir-lang/poseidon" }}
""")

    circuit_code = gen_circuit_const_e_computed(pk_b_rows, pk_a_rows)
    with open(os.path.join(circuit_dir, "src", "main.nr"), "w") as f:
        f.write(circuit_code)
    write_prover_toml(os.path.join(circuit_dir, "Prover.toml"), witness_data,
                      include_e=False, include_pk_rows=False)
    # Try prove — may fail due to sunspot witness mismatch
    metrics = run_benchmark(variant, circuit_dir, try_prove=True)
    all_results.append(metrics)

    # ============================================================
    # Variant 4: var PK + e computed
    # ============================================================
    variant = "var_pk_e_computed"
    print(f"\n{'='*60}")
    print(f"Variant 4: {variant}")
    print(f"{'='*60}")
    circuit_dir = os.path.join(PROJ_DIR, f"bench_{variant}")
    os.makedirs(os.path.join(circuit_dir, "src"), exist_ok=True)
    shutil.rmtree(os.path.join(circuit_dir, "target"), ignore_errors=True)

    with open(os.path.join(circuit_dir, "Nargo.toml"), "w") as f:
        f.write(f"""[package]
name = "{variant}"
type = "bin"
authors = [""]
compiler_version = ">=0.39.0"

[dependencies]
poseidon = {{ tag = "v0.1.1", git = "https://github.com/noir-lang/poseidon" }}
""")

    circuit_code = gen_circuit_var_e_computed()
    with open(os.path.join(circuit_dir, "src", "main.nr"), "w") as f:
        f.write(circuit_code)
    write_prover_toml(os.path.join(circuit_dir, "Prover.toml"), witness_data,
                      include_e=False, include_pk_rows=True,
                      pk_b_rows=pk_b_rows, pk_a_rows=pk_a_rows)
    metrics = run_benchmark(variant, circuit_dir, try_prove=True)
    all_results.append(metrics)

    # ============================================================
    # Print results
    # ============================================================
    print(f"\n{'='*80}")
    print("BENCHMARK RESULTS (q={}, Delta={}, N={}, MSG_SLOTS={})".format(
        RLWE_Q, DELTA, N, MSG_SLOTS))
    print(f"{'='*80}")

    header = f"{'Variant':<28} {'Constraints':>12} {'Compile':>10} {'Execute':>10} {'Prove':>10} {'Verify':>10} {'Proof':>8} {'CCS':>8} {'main.nr':>10} {'Prover':>10}"
    print(header)
    print("-" * len(header))

    for m in all_results:
        constraints = str(m.get("constraints", "?"))
        compile_t = f"{m['compile_time']:.1f}s"
        execute_t = f"{m['execute_time']:.1f}s"
        prove_t = f"{m['prove_time']:.1f}s" if m.get('prove_time') else "FAIL"
        verify_t = f"{m['verify_time']:.2f}s" if m.get('verify_time') else "FAIL"
        proof_s = f"{m['proof_size']}B" if m.get('proof_size') else "FAIL"
        ccs_s = f"{m['ccs_size']:.1f}MB"
        main_s = f"{m['circuit_file_size']:.1f}MB"
        prover_s = f"{m['prover_toml_size']:.0f}KB"
        print(f"{m['name']:<28} {constraints:>12} {compile_t:>10} {execute_t:>10} {prove_t:>10} {verify_t:>10} {proof_s:>8} {ccs_s:>8} {main_s:>10} {prover_s:>10}")

    # Save JSON
    results_path = os.path.join(PROJ_DIR, "benchmark_results.json")
    with open(results_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\nResults saved to {results_path}")


def divmod_with_remainder(full_value, q):
    r = full_value % q
    k = (full_value - r) // q
    return k, r


if __name__ == "__main__":
    main()

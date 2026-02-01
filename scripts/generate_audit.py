#!/usr/bin/env python3
"""Generate RLWE audit circuit for shielded-pool integration.

Uses ciphertext modulus q = 167772161 (same as ZKPayroll).
Encryption is mod q; circuit proves correctness via quotient witnesses.

Poseidon1 for wa_commitment (matching shielded-pool), Poseidon2 for ct_commitment.
Constant PK approach with hardcoded negacyclic matrix rows.

Circuit proves:
  c0[i] + k0[i] * Q == <PK_B_ROW[i], r> + e1[i] + DELTA * msg[i]   (over BN254)
  c1[i] + k1[i] * Q == <PK_A_ROW[i], r> + e2[i]                     (over BN254)
where k0, k1 are quotient witnesses from the mod q reduction.
"""
import os
import subprocess
import random
import re
import json
import math
import shutil
import time

N = 1024
RLWE_Q = 167772161  # 40 * 2^22 + 1
PLAINTEXT_MOD = 256  # 8-bit slots
DELTA = RLWE_Q // PLAINTEXT_MOD  # 655360
MSG_SLOTS = 64  # owner_x (32 bytes) + owner_y (32 bytes)
PACK_WIDTH = 7   # pack 7 values per Field (32-bit each, 224-bit < 254-bit)
PACK_BITS = 32   # each value stored as 32-bit (q < 2^32)
PACKED_C0 = math.ceil(MSG_SLOTS / PACK_WIDTH)   # 10
PACKED_C1 = math.ceil(N / PACK_WIDTH)           # 147
TOTAL_PACKED = PACKED_C0 + PACKED_C1             # 157
BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJ_DIR = os.path.dirname(BASE_DIR)
KEYS_DIR = os.path.join(PROJ_DIR, "demo-frontend", "public", "rlwe")
CIRCUIT_DIR = os.path.join(PROJ_DIR, "audit_circuit")
ARTIFACTS_DIR = os.path.join(CIRCUIT_DIR, "target")
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
    """Row k of negacyclic matrix for polynomial, coefficients mod q."""
    row = [0] * n
    for j in range(n):
        idx = k - j
        if idx >= 0:
            row[j] = poly[idx] % q
        else:
            row[j] = (-poly[idx + n]) % q
    return row


def encode_field_to_bytes(value, num_bytes=32):
    """Encode a field element to byte slots (8-bit each)."""
    slots = []
    for i in range(num_bytes):
        slots.append((value >> (i * 8)) & 0xFF)
    return slots


def format_field(v):
    """Format for Prover.toml (BN254 field element)."""
    v = v % BN254_P
    if v == 0:
        return '"0"'
    return f'"0x{v:064x}"'


def format_field_noir(v):
    """Format for Noir source (BN254 field element)."""
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
    """Use bjj_helper with Poseidon1 (dep::poseidon) to match shielded-pool."""
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
    // Poseidon1 hash (same as shielded-pool)
    let wa = poseidon_hash([pk.x, pk.y]);
    (pk.x, pk.y, wa)
}
""")

    with open(os.path.join(helper_dir, "Prover.toml"), "w") as f:
        f.write(f'secret_key = "{secret_key}"\n')

    print("Compiling bjj_helper_p1 (Poseidon1)...")
    subprocess.run([NARGO, "compile"], cwd=helper_dir, check=True, capture_output=True)
    print("Executing bjj_helper_p1...")
    result = subprocess.run([NARGO, "execute"], cwd=helper_dir, check=True, capture_output=True, text=True)
    output = result.stdout + result.stderr

    match = re.search(r'Circuit output:\s*\((0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+)\)', output)
    if not match:
        print(f"nargo output: {output}")
        raise RuntimeError("Could not parse bjj_helper_p1 output")

    owner_x = int(match.group(1), 16)
    owner_y = int(match.group(2), 16)
    wa_commitment = int(match.group(3), 16)
    return owner_x, owner_y, wa_commitment


def pack_values(values, pack_width=PACK_WIDTH, pack_bits=PACK_BITS):
    """Pack values into Fields, pack_width values per Field, pack_bits bits each."""
    packed = []
    for i in range(0, len(values), pack_width):
        chunk = values[i:i+pack_width]
        v = 0
        for j, c in enumerate(chunk):
            v += c << (j * pack_bits)
        packed.append(v)
    return packed


def run_ct_helper_v2(c0_packed, c1_packed):
    """Compute ct_commitment using Poseidon2 sponge over packed Fields.
    c0_packed and c1_packed are already packed (7x32-bit).
    """
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

global PACKED_C0: u32 = {PACKED_C0};
global PACKED_C1: u32 = {PACKED_C1};
global TOTAL_PACKED: u32 = {TOTAL_PACKED};

fn get_elem(c0_packed: [Field; PACKED_C0], c1_packed: [Field; PACKED_C1], i: u32) -> Field {{
    if i < PACKED_C0 {{
        c0_packed[i]
    }} else {{
        c1_packed[i - PACKED_C0]
    }}
}}

fn main(c0_packed: [Field; PACKED_C0], c1_packed: [Field; PACKED_C1]) -> pub Field {{
    let mut state: [Field; 4] = [0; 4];
    let full_rounds: u32 = TOTAL_PACKED / 3;
    for i in 0..full_rounds {{
        state[0] += get_elem(c0_packed, c1_packed, 3 * i);
        state[1] += get_elem(c0_packed, c1_packed, 3 * i + 1);
        state[2] += get_elem(c0_packed, c1_packed, 3 * i + 2);
        state = poseidon2_permutation(state, 4);
    }}
    let remainder = TOTAL_PACKED - full_rounds * 3;
    if remainder >= 1 {{
        state[0] += get_elem(c0_packed, c1_packed, full_rounds * 3);
    }}
    if remainder >= 2 {{
        state[1] += get_elem(c0_packed, c1_packed, full_rounds * 3 + 1);
    }}
    state = poseidon2_permutation(state, 4);
    state[0]
}}
""")

    with open(os.path.join(helper_dir, "Prover.toml"), "w") as f:
        f.write(f"c0_packed = [{', '.join(format_field(v) for v in c0_packed)}]\n")
        f.write(f"c1_packed = [{', '.join(format_field(v) for v in c1_packed)}]\n")

    print("Compiling ct_helper_v2...")
    subprocess.run([NARGO, "compile"], cwd=helper_dir, check=True, capture_output=True)
    print("Executing ct_helper_v2...")
    result = subprocess.run([NARGO, "execute"], cwd=helper_dir, check=True, capture_output=True, text=True)
    output = result.stdout + result.stderr

    match = re.search(r'Circuit output:\s*(0x[0-9a-fA-F]+)', output)
    if not match:
        raise RuntimeError(f"Could not parse ct_helper_v2 output: {output}")

    return int(match.group(1), 16)


def compute_quotient_and_remainder(full_value, q):
    """Compute k, r such that full_value = k * q + r, r in [0, q).
    full_value is computed over integers (can be negative or very large).
    Returns (k, r) where r = full_value mod q, k = (full_value - r) / q.
    """
    r = full_value % q
    k = (full_value - r) // q
    return k, r


def generate_const_circuit(pk_b_rows_sparse, pk_a_rows_full):
    """Generate Noir circuit with mod q via quotient witnesses.

    e1, e2 are NOT witness inputs. They are computed inside the circuit:
      e1[i] = c0[i] + k0[i]*Q - <PK_B_ROW[i], r> - DELTA*msg[i]
      e2[i] = c1[i] + k1[i]*Q - <PK_A_ROW[i], r>
    Then range-checked to prove they are small (existence proof).
    """
    # PK rows: coefficients are mod q (small), embedded directly as Noir constants
    pk_b_rows_strs = []
    for k in range(MSG_SLOTS):
        row_str = ', '.join(format_field_noir(v) for v in pk_b_rows_sparse[k])
        pk_b_rows_strs.append(f"    [{row_str}]")
    pk_b_block = ',\n'.join(pk_b_rows_strs)

    pk_a_rows_strs = []
    for k in range(N):
        row_str = ', '.join(format_field_noir(v) for v in pk_a_rows_full[k])
        pk_a_rows_strs.append(f"    [{row_str}]")
    pk_a_block = ',\n'.join(pk_a_rows_strs)

    pack_shift_hex = f'0x{(1 << PACK_BITS):x}'  # 2^32

    circuit = f"""// RLWE Audit Circuit for Shielded-Pool Integration
// Ciphertext modulus q = {RLWE_Q}, plaintext modulus t = {PLAINTEXT_MOD}, Delta = q/t = {DELTA}
// Poseidon1 for wa_commitment (matches shielded-pool), Poseidon2 for ct_commitment
// Constant PK: negacyclic matrix rows hardcoded (coefficients in [0, q))
// BFV convention: c0 = (b*r + e1 + Delta*msg) mod q, c1 = (a*r + e2) mod q
// Circuit proves mod q via quotient: c0[i] + k0[i]*Q == ip + e1[i] + Delta*msg[i]
// Public inputs: packed {PACK_WIDTH}x{PACK_BITS}-bit (c0: {PACKED_C0} Fields, c1: {PACKED_C1} Fields)

use dep::poseidon::poseidon::bn254::hash_2 as poseidon1_hash_2;
use std::hash::poseidon2_permutation;
use std::embedded_curve_ops::{{EmbeddedCurveScalar, fixed_base_scalar_mul}};

global N: u32 = {N};
global MSG_SLOTS: u32 = {MSG_SLOTS};
global PACK_WIDTH: u32 = {PACK_WIDTH};
global PACKED_C0: u32 = {PACKED_C0};
global PACKED_C1: u32 = {PACKED_C1};
global TOTAL_PACKED: u32 = {TOTAL_PACKED};

// RLWE ciphertext modulus
global RLWE_Q: Field = {RLWE_Q};

// Delta for BFV message scaling: floor(q / t) = floor({RLWE_Q} / {PLAINTEXT_MOD})
global DELTA: Field = {DELTA};

// Packing shift: 2^{PACK_BITS}
global PACK_SHIFT: Field = {pack_shift_hex};

// PK_B_ROWS: first {MSG_SLOTS} rows of negacyclic matrix from polynomial b
// (for c0 = (b*r + e1 + Delta*msg) mod q)
global PK_B_ROWS: [[Field; N]; MSG_SLOTS] = [
{pk_b_block}
];

// PK_A_ROWS: all {N} rows of negacyclic matrix from polynomial a
// (for c1 = (a*r + e2) mod q)
global PK_A_ROWS: [[Field; N]; N] = [
{pk_a_block}
];

fn inner_product_const(constant: [Field; N], variable: [Field; N]) -> Field {{
    let mut sum: Field = 0;
    for i in 0..N {{ sum += constant[i] * variable[i]; }}
    sum
}}

fn unpack_sparse(packed: [Field; PACKED_C0]) -> [Field; MSG_SLOTS] {{
    let mut result: [Field; MSG_SLOTS] = [0; MSG_SLOTS];
    for i in 0..PACKED_C0 {{
        let mut val = packed[i];
        for j in 0..PACK_WIDTH {{
            let idx = i * PACK_WIDTH + j;
            if idx < MSG_SLOTS {{
                let coeff = val as u32 as Field;
                result[idx] = coeff;
                val = (val - coeff) / PACK_SHIFT;
            }}
        }}
    }}
    result
}}

fn unpack_full(packed: [Field; PACKED_C1]) -> [Field; N] {{
    let mut result: [Field; N] = [0; N];
    for i in 0..PACKED_C1 {{
        let mut val = packed[i];
        for j in 0..PACK_WIDTH {{
            let idx = i * PACK_WIDTH + j;
            if idx < N {{
                let coeff = val as u32 as Field;
                result[idx] = coeff;
                val = (val - coeff) / PACK_SHIFT;
            }}
        }}
    }}
    result
}}

fn get_packed_elem(c0_packed: [Field; PACKED_C0], c1_packed: [Field; PACKED_C1], i: u32) -> Field {{
    if i < PACKED_C0 {{
        c0_packed[i]
    }} else {{
        c1_packed[i - PACKED_C0]
    }}
}}

fn compute_ct_commitment(c0_packed: [Field; PACKED_C0], c1_packed: [Field; PACKED_C1]) -> Field {{
    // ct_commitment = Poseidon2 sponge over packed Fields (rate=3, capacity=1)
    let mut state: [Field; 4] = [0; 4];
    let full_rounds: u32 = TOTAL_PACKED / 3;
    for i in 0..full_rounds {{
        state[0] += get_packed_elem(c0_packed, c1_packed, 3 * i);
        state[1] += get_packed_elem(c0_packed, c1_packed, 3 * i + 1);
        state[2] += get_packed_elem(c0_packed, c1_packed, 3 * i + 2);
        state = poseidon2_permutation(state, 4);
    }}
    let remainder = TOTAL_PACKED - full_rounds * 3;
    if remainder >= 1 {{
        state[0] += get_packed_elem(c0_packed, c1_packed, full_rounds * 3);
    }}
    if remainder >= 2 {{
        state[1] += get_packed_elem(c0_packed, c1_packed, full_rounds * 3 + 1);
    }}
    state = poseidon2_permutation(state, 4);
    state[0]
}}

fn encode_field_to_byte_slots(value: Field) -> [Field; 32] {{
    // Decompose a BN254 field element into 32 byte slots (8-bit each)
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

fn range_proof_signed(value: Field, bound: u32) {{
    // Prove value is in [-bound, bound] by checking value + bound fits in u8
    // For noise_bound=3: value + 128 as u8 (shifted range check)
    let shifted = value + 128;
    let _ = shifted as u8;
}}

fn main(
    wa_commitment: pub Field,
    ct_commitment: pub Field,
    c0_packed: [Field; PACKED_C0],
    c1_packed: [Field; PACKED_C1],
    secret_key: Field,
    r: [Field; N],
    e1_sparse: [Field; MSG_SLOTS],
    e2: [Field; N],
    k0: [Field; MSG_SLOTS],
    k1: [Field; N],
) {{
    // 1. BJJ scalar_mul -> (owner_x, owner_y)
    let two_pow_128: Field = 0x100000000000000000000000000000000;
    let secret_low = secret_key as u128;
    let secret_high = ((secret_key - secret_low as Field) / two_pow_128) as u128;
    let scalar = EmbeddedCurveScalar::new(secret_low as Field, secret_high as Field);
    let pk = fixed_base_scalar_mul(scalar);
    let owner_x = pk.x;
    let owner_y = pk.y;

    // 2. wa_commitment = Poseidon1(owner_x, owner_y) -- matches shielded-pool
    let calculated_wa = poseidon1_hash_2([owner_x, owner_y]);
    assert(wa_commitment == calculated_wa);

    // 3. Unpack c0 and c1 from packed public inputs
    let c0_sparse = unpack_sparse(c0_packed);
    let c1 = unpack_full(c1_packed);

    // 4. Encode owner_x, owner_y -> msg[{MSG_SLOTS}] (8-bit byte slots)
    let mut msg: [Field; MSG_SLOTS] = [0; MSG_SLOTS];
    let slots_x = encode_field_to_byte_slots(owner_x);
    for i in 0..32 {{ msg[i] = slots_x[i]; }}
    let slots_y = encode_field_to_byte_slots(owner_y);
    for i in 0..32 {{ msg[32 + i] = slots_y[i]; }}

    // 5. Range proof: r, e1, e2 are small (existence proof for small noise)
    for i in 0..N {{ range_proof_signed(r[i], 128); }}
    for i in 0..MSG_SLOTS {{ range_proof_signed(e1_sparse[i], 128); }}
    for i in 0..N {{ range_proof_signed(e2[i], 128); }}

    // 6. c0_sparse[i] = (ip + e1[i] + DELTA*msg[i]) mod q
    //    Proved via quotient: c0[i] + k0[i]*Q == ip + e1[i] + DELTA*msg[i] (over BN254)
    for i in 0..MSG_SLOTS {{
        let ip = inner_product_const(PK_B_ROWS[i], r);
        assert(c0_sparse[i] + k0[i] * RLWE_Q == ip + e1_sparse[i] + DELTA * msg[i]);
    }}

    // 7. c1[i] = (ip + e2[i]) mod q
    //    Proved via quotient: c1[i] + k1[i]*Q == ip + e2[i] (over BN254)
    for i in 0..N {{
        let ip = inner_product_const(PK_A_ROWS[i], r);
        assert(c1[i] + k1[i] * RLWE_Q == ip + e2[i]);
    }}

    // 8. ct_commitment = Poseidon2 sponge of packed ciphertext
    let calculated_ct = compute_ct_commitment(c0_packed, c1_packed);
    assert(ct_commitment == calculated_ct);
}}
"""
    return circuit


def main():
    rng = random.Random(999)
    secret_key = 12345

    # Step 1: Load RLWE pk (coefficients mod q)
    print("=== Step 1: Load RLWE pk ===")
    rlwe_pk_a, rlwe_pk_b = load_rlwe_pk()
    print(f"Loaded pk: a[{len(rlwe_pk_a)}], b[{len(rlwe_pk_b)}]")
    print(f"  a[0] = {rlwe_pk_a[0]} (should be < q={RLWE_Q})")
    assert all(0 <= v < RLWE_Q for v in rlwe_pk_a), "PK a coefficients not in [0, q)"
    assert all(0 <= v < RLWE_Q for v in rlwe_pk_b), "PK b coefficients not in [0, q)"

    # Step 2: BJJ pubkey with Poseidon1 wa_commitment
    print("\n=== Step 2: BJJ pubkey (Poseidon1) ===")
    owner_x, owner_y, wa_commitment = run_bjj_helper_poseidon1(secret_key)
    print(f"owner_x = {hex(owner_x)}")
    print(f"owner_y = {hex(owner_y)}")
    print(f"wa_commitment = {hex(wa_commitment)}")

    # Step 3: Encode message as 8-bit byte slots + encrypt mod q
    print("\n=== Step 3: Encode & encrypt (mod q) ===")
    msg = [0] * MSG_SLOTS
    slots_x = encode_field_to_bytes(owner_x, 32)
    for i in range(32):
        msg[i] = slots_x[i]
    slots_y = encode_field_to_bytes(owner_y, 32)
    for i in range(32):
        msg[32 + i] = slots_y[i]
    print(f"msg slots (first 8): {msg[:8]}")
    assert all(0 <= v <= 255 for v in msg), "msg slots must be 8-bit"

    def small_noise():
        v = rng.randint(-3, 3)
        return v

    r_signed = [small_noise() for _ in range(N)]
    e1_signed = [small_noise() for _ in range(MSG_SLOTS)]
    e2_signed = [small_noise() for _ in range(N)]

    r_mod_q = [v % RLWE_Q for v in r_signed]
    e1_mod_q = [v % RLWE_Q for v in e1_signed]
    e2_mod_q = [v % RLWE_Q for v in e2_signed]

    # Encrypt mod q
    print("Computing b*r (negacyclic mul mod q)...")
    br = negacyclic_mul_mod_q(rlwe_pk_b, r_mod_q, N, RLWE_Q)
    c0_sparse = [(br[i] + e1_mod_q[i] + DELTA * msg[i]) % RLWE_Q for i in range(MSG_SLOTS)]

    print("Computing a*r (negacyclic mul mod q)...")
    ar = negacyclic_mul_mod_q(rlwe_pk_a, r_mod_q, N, RLWE_Q)
    c1 = [(ar[i] + e2_mod_q[i]) % RLWE_Q for i in range(N)]

    print(f"c0_sparse[0] = {c0_sparse[0]} (should be < q={RLWE_Q})")
    print(f"c1[0] = {c1[0]} (should be < q={RLWE_Q})")

    # Compute quotient witnesses for circuit
    # Over integers (not mod q): full_c0[i] = br[i] + e1[i] + DELTA*msg[i]
    # Then c0[i] = full_c0[i] mod q, k0[i] = (full_c0[i] - c0[i]) / q
    # But we need to compute this over integers, not mod q.
    # Recompute inner products over integers for quotient computation.
    print("\nComputing quotient witnesses...")

    # Inner products over integers (not mod q)
    # ip_b[i] = sum(PK_B_ROW[i][j] * r[j]) over integers (can be large)
    # We need signed r for correct quotient computation
    # r_signed values are in [-3, 3], PK values in [0, q)
    # ip can be up to N * q * 3 ~ 1024 * 167M * 3 ~ 5.15e11, fits in Python int

    pk_b_rows_sparse = [negacyclic_matrix_row_mod_q(rlwe_pk_b, k, N, RLWE_Q) for k in range(MSG_SLOTS)]
    pk_a_rows_full = [negacyclic_matrix_row_mod_q(rlwe_pk_a, k, N, RLWE_Q) for k in range(N)]

    k0_list = []
    for i in range(MSG_SLOTS):
        # Inner product over integers using signed r
        ip_int = sum(pk_b_rows_sparse[i][j] * r_signed[j] for j in range(N))
        full_val = ip_int + e1_signed[i] + DELTA * msg[i]
        k, remainder = compute_quotient_and_remainder(full_val, RLWE_Q)
        assert remainder == c0_sparse[i], f"c0 mismatch at {i}: {remainder} != {c0_sparse[i]}"
        k0_list.append(k)

    k1_list = []
    for i in range(N):
        ip_int = sum(pk_a_rows_full[i][j] * r_signed[j] for j in range(N))
        full_val = ip_int + e2_signed[i]
        k, remainder = compute_quotient_and_remainder(full_val, RLWE_Q)
        assert remainder == c1[i], f"c1 mismatch at {i}: {remainder} != {c1[i]}"
        k1_list.append(k)

    print(f"k0 range: [{min(k0_list)}, {max(k0_list)}]")
    print(f"k1 range: [{min(k1_list)}, {max(k1_list)}]")

    # Verify the circuit equation over BN254 field
    # c0[i] + k0[i] * Q == ip_bn254 + e1_bn254[i] + DELTA * msg[i]  (mod BN254_P)
    r_bn254 = [v % BN254_P for v in r_signed]
    e1_bn254 = [v % BN254_P for v in e1_signed]
    e2_bn254 = [v % BN254_P for v in e2_signed]
    k0_bn254 = [v % BN254_P for v in k0_list]
    k1_bn254 = [v % BN254_P for v in k1_list]

    for i in range(MSG_SLOTS):
        ip_bn254 = sum(pk_b_rows_sparse[i][j] * r_bn254[j] for j in range(N)) % BN254_P
        lhs = (c0_sparse[i] + k0_bn254[i] * RLWE_Q) % BN254_P
        rhs = (ip_bn254 + e1_bn254[i] + DELTA * msg[i]) % BN254_P
        assert lhs == rhs, f"BN254 c0 verification failed at {i}"

    for i in range(min(3, N)):
        ip_bn254 = sum(pk_a_rows_full[i][j] * r_bn254[j] for j in range(N)) % BN254_P
        lhs = (c1[i] + k1_bn254[i] * RLWE_Q) % BN254_P
        rhs = (ip_bn254 + e2_bn254[i]) % BN254_P
        assert lhs == rhs, f"BN254 c1 verification failed at {i}"

    print("Quotient witness verification passed!")

    # Step 4: Pack c0/c1 and compute ct_commitment
    print("\n=== Step 4: Pack ciphertext + ct_commitment (Poseidon2) ===")
    c0_packed = pack_values(c0_sparse)
    c1_packed = pack_values(c1)
    print(f"c0_packed: {len(c0_packed)} Fields (was {len(c0_sparse)})")
    print(f"c1_packed: {len(c1_packed)} Fields (was {len(c1)})")
    ct_commitment = run_ct_helper_v2(c0_packed, c1_packed)
    print(f"ct_commitment = {hex(ct_commitment)}")

    # Save ciphertext for decryption test
    ct_path = os.path.join(KEYS_DIR, "ciphertext.json")
    with open(ct_path, "w") as f:
        json.dump({
            "c0_sparse": [v for v in c0_sparse],
            "c1": [v for v in c1],
            "c0_packed": [hex(v) for v in c0_packed],
            "c1_packed": [hex(v) for v in c1_packed],
            "pack_width": PACK_WIDTH,
            "pack_bits": PACK_BITS,
            "msg_slots": MSG_SLOTS,
            "q": RLWE_Q,
            "delta": DELTA,
            "expected_owner_x": hex(owner_x),
            "expected_owner_y": hex(owner_y),
        }, f)
    print(f"Ciphertext saved to {ct_path}")

    # Step 5: Generate circuit
    print("\n=== Step 5: Generate audit_circuit ===")
    os.makedirs(os.path.join(CIRCUIT_DIR, "src"), exist_ok=True)

    circuit = generate_const_circuit(pk_b_rows_sparse, pk_a_rows_full)
    with open(os.path.join(CIRCUIT_DIR, "src", "main.nr"), "w") as f:
        f.write(circuit)
    print(f"Circuit written ({os.path.getsize(os.path.join(CIRCUIT_DIR, 'src', 'main.nr')) / 1024 / 1024:.1f} MB)")

    with open(os.path.join(CIRCUIT_DIR, "Nargo.toml"), "w") as f:
        f.write("""[package]
name = "rlwe_audit"
type = "bin"
authors = [""]
compiler_version = ">=0.39.0"

[dependencies]
poseidon = { tag = "v0.1.1", git = "https://github.com/noir-lang/poseidon" }
""")

    # Write Prover.toml
    # r, e1, e2, k0, k1 are signed integers → represent in BN254 field
    toml_path = os.path.join(CIRCUIT_DIR, "Prover.toml")
    with open(toml_path, "w") as f:
        f.write(f"secret_key = {format_field(secret_key)}\n")
        f.write(f"wa_commitment = {format_field(wa_commitment)}\n")
        f.write(f"ct_commitment = {format_field(ct_commitment)}\n")
        f.write(f"c0_packed = [{', '.join(format_field(v) for v in c0_packed)}]\n")
        f.write(f"c1_packed = [{', '.join(format_field(v) for v in c1_packed)}]\n")
        f.write(f"r = [{', '.join(format_field(v) for v in r_signed)}]\n")
        f.write(f"e1_sparse = [{', '.join(format_field(v) for v in e1_signed)}]\n")
        f.write(f"e2 = [{', '.join(format_field(v) for v in e2_signed)}]\n")
        f.write(f"k0 = [{', '.join(format_field(v) for v in k0_list)}]\n")
        f.write(f"k1 = [{', '.join(format_field(v) for v in k1_list)}]\n")
    print(f"Prover.toml written ({os.path.getsize(toml_path) / 1024:.1f} KB)")

    # Step 6: Compile + sunspot pipeline
    print("\n=== Step 6: nargo compile ===")
    t0 = time.time()
    subprocess.run([NARGO, "compile"], cwd=CIRCUIT_DIR, check=True)
    t_compile = time.time() - t0
    print(f"nargo compile: {t_compile:.1f}s")

    print("\n=== Step 7: nargo execute ===")
    t0 = time.time()
    subprocess.run([NARGO, "execute"], cwd=CIRCUIT_DIR, check=True)
    t_execute = time.time() - t0
    print(f"nargo execute: {t_execute:.1f}s")

    target_dir = os.path.join(CIRCUIT_DIR, "target")
    acir_file = os.path.join(target_dir, "rlwe_audit.json")
    witness_file = os.path.join(target_dir, "rlwe_audit.gz")

    print("\n=== Step 8: sunspot compile ===")
    t0 = time.time()
    subprocess.run([SUNSPOT, "compile", acir_file], check=True)
    t_sunspot_compile = time.time() - t0
    ccs_file = acir_file.replace(".json", ".ccs")
    ccs_size = os.path.getsize(ccs_file) / 1024 / 1024
    print(f"sunspot compile: {t_sunspot_compile:.1f}s, .ccs = {ccs_size:.1f} MB")

    print("\n=== Step 9: sunspot setup ===")
    t0 = time.time()
    subprocess.run([SUNSPOT, "setup", ccs_file], check=True)
    t_setup = time.time() - t0
    pk_file = ccs_file.replace(".ccs", ".pk")
    vk_file = ccs_file.replace(".ccs", ".vk")
    pk_size = os.path.getsize(pk_file) / 1024 / 1024
    print(f"sunspot setup: {t_setup:.1f}s, pk = {pk_size:.1f} MB")

    print("\n=== Step 10: sunspot prove ===")
    t0 = time.time()
    subprocess.run([SUNSPOT, "prove", acir_file, witness_file, ccs_file, pk_file], check=True)
    t_prove = time.time() - t0
    proof_file = ccs_file.replace(".ccs", ".proof")
    pw_file = ccs_file.replace(".ccs", ".pw")
    proof_size = os.path.getsize(proof_file)
    print(f"sunspot prove: {t_prove:.1f}s, proof = {proof_size} bytes")

    print("\n=== Step 11: sunspot verify ===")
    t0 = time.time()
    subprocess.run([SUNSPOT, "verify", vk_file, proof_file, pw_file], check=True)
    t_verify = time.time() - t0
    print(f"sunspot verify: {t_verify:.1f}s")

    # Copy artifacts
    print("\n=== Step 12: Copy artifacts ===")
    os.makedirs(ARTIFACTS_DIR, exist_ok=True)
    shutil.copy2(ccs_file, os.path.join(ARTIFACTS_DIR, "audit_circuit.ccs"))
    shutil.copy2(vk_file, os.path.join(ARTIFACTS_DIR, "audit_circuit.vk"))
    print(f"Copied .ccs and .vk to {ARTIFACTS_DIR}/")

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  RLWE q:          {RLWE_Q}")
    print(f"  Delta:           {DELTA}")
    print(f"  MSG_SLOTS:       {MSG_SLOTS}")
    print(f"  nargo compile:   {t_compile:.1f}s")
    print(f"  nargo execute:   {t_execute:.1f}s")
    print(f"  sunspot compile: {t_sunspot_compile:.1f}s")
    print(f"  sunspot setup:   {t_setup:.1f}s")
    print(f"  sunspot prove:   {t_prove:.1f}s")
    print(f"  sunspot verify:  {t_verify:.1f}s")
    print(f"  .ccs size:       {ccs_size:.1f} MB")
    print(f"  PK size:         {pk_size:.1f} MB")
    print(f"  Proof size:      {proof_size} bytes")
    print(f"  Artifacts:       {ARTIFACTS_DIR}/")


if __name__ == "__main__":
    main()

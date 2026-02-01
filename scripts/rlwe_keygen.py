#!/usr/bin/env python3
"""RLWE keypair generation + Shamir secret sharing for audit module.

Uses ciphertext modulus q = 167772161 (NTT-friendly prime, same as ZKPayroll).
All RLWE operations are mod q, NOT mod BN254.
Shamir secret sharing is over BN254 for ZK compatibility.

Generates:
  demo-frontend/public/rlwe/rlwe_pk.json       - public key (a, b polynomials, coefficients in [0, q))
  demo-frontend/public/rlwe/rlwe_params.json   - parameters
  demo-frontend/public/rlwe/rlwe_sk_shares/    - Shamir shares of sk (over BN254)
"""
import os
import json
import random
import sys

N = 1024
NOISE_BOUND = 3
RLWE_Q = 167772161  # 40 * 2^22 + 1, NTT-friendly prime
BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617

# Shamir params
THRESHOLD = 2
NUM_SHARES = 3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJ_DIR = os.path.dirname(BASE_DIR)
KEYS_DIR = os.path.join(PROJ_DIR, "demo-frontend", "public", "rlwe")


def negacyclic_mul_mod_q(a, b, n, q):
    """Negacyclic polynomial multiplication mod q."""
    result = [0] * n
    for i in range(n):
        for j in range(n):
            idx = i + j
            if idx < n:
                result[idx] = (result[idx] + a[i] * b[j]) % q
            else:
                result[idx - n] = (result[idx - n] - a[i] * b[j]) % q
    return result


def small_noise(rng):
    """Small noise in [-NOISE_BOUND, NOISE_BOUND], returned mod q."""
    v = rng.randint(-NOISE_BOUND, NOISE_BOUND)
    return v % RLWE_Q


def shamir_share_field(secret, threshold, num_shares, rng):
    """Shamir secret sharing of a single field element over BN254."""
    coeffs = [secret % BN254_P]
    for _ in range(threshold - 1):
        coeffs.append(rng.randint(0, BN254_P - 1))

    shares = []
    for i in range(1, num_shares + 1):
        val = 0
        x_pow = 1
        for c in coeffs:
            val = (val + c * x_pow) % BN254_P
            x_pow = (x_pow * i) % BN254_P
        shares.append((i, val))
    return shares


def shamir_reconstruct_field(shares, threshold):
    """Lagrange interpolation at x=0 to recover secret."""
    secret = 0
    xs = [s[0] for s in shares[:threshold]]
    ys = [s[1] for s in shares[:threshold]]

    for i in range(threshold):
        num = ys[i]
        for j in range(threshold):
            if i != j:
                num = num * (-xs[j]) % BN254_P
                inv = pow(xs[i] - xs[j], BN254_P - 2, BN254_P)
                num = num * inv % BN254_P
        secret = (secret + num) % BN254_P
    return secret


def to_hex_q(v):
    """Hex representation for values mod q."""
    v = v % RLWE_Q
    return f"0x{v:08x}"


def to_hex_bn254(v):
    v = v % BN254_P
    if v == 0:
        return "0x0"
    return f"0x{v:064x}"


def main():
    rng = random.Random(42)

    print(f"=== RLWE Keygen (N={N}, q={RLWE_Q}) ===")

    # Generate secret key: small polynomial with coeffs in [-NOISE_BOUND, NOISE_BOUND]
    sk_signed = [rng.randint(-NOISE_BOUND, NOISE_BOUND) for _ in range(N)]
    sk_mod_q = [v % RLWE_Q for v in sk_signed]
    print(f"sk generated: {sum(1 for s in sk_signed if s != 0)} nonzero coefficients")

    # Generate public key mod q: a random in [0, q), e small noise
    # b = -(a*sk) + e mod q  (BFV convention)
    a = [rng.randint(0, RLWE_Q - 1) for _ in range(N)]
    e_signed = [rng.randint(-NOISE_BOUND, NOISE_BOUND) for _ in range(N)]
    e_mod_q = [v % RLWE_Q for v in e_signed]

    print("Computing a*sk (negacyclic mul mod q)...")
    a_sk = negacyclic_mul_mod_q(a, sk_mod_q, N, RLWE_Q)
    b = [((-a_sk[i]) + e_mod_q[i]) % RLWE_Q for i in range(N)]

    print("Public key generated.")

    # Save pk (coefficients in [0, q))
    os.makedirs(KEYS_DIR, exist_ok=True)
    pk_path = os.path.join(KEYS_DIR, "rlwe_pk.json")
    with open(pk_path, "w") as f:
        json.dump({
            "a": [to_hex_q(v) for v in a],
            "b": [to_hex_q(v) for v in b],
        }, f)
    print(f"PK saved to {pk_path} ({os.path.getsize(pk_path) / 1024:.1f} KB)")

    # Save params
    params_path = os.path.join(KEYS_DIR, "rlwe_params.json")
    with open(params_path, "w") as f:
        json.dump({
            "N": N,
            "q": RLWE_Q,
            "noise_bound": NOISE_BOUND,
            "plaintext_modulus": 256,
            "delta": RLWE_Q // 256,
            "threshold": THRESHOLD,
            "num_shares": NUM_SHARES,
            "field": "BN254",
        }, f, indent=2)
    print(f"Params saved to {params_path}")

    # Shamir secret sharing of sk over BN254
    # sk coeffs are small signed values; represent in BN254 field
    print(f"\n=== Shamir Secret Sharing ({THRESHOLD}-of-{NUM_SHARES}) ===")
    sk_bn254 = [v % BN254_P for v in sk_signed]  # signed -> BN254 field

    all_shares = [[] for _ in range(NUM_SHARES)]

    for coeff_idx in range(N):
        shares = shamir_share_field(sk_bn254[coeff_idx], THRESHOLD, NUM_SHARES, rng)
        for share_idx in range(NUM_SHARES):
            all_shares[share_idx].append(shares[share_idx])

    shares_dir = os.path.join(KEYS_DIR, "rlwe_sk_shares")
    os.makedirs(shares_dir, exist_ok=True)
    for share_idx in range(NUM_SHARES):
        share_path = os.path.join(shares_dir, f"share_{share_idx + 1}.json")
        share_data = {
            "share_index": share_idx + 1,
            "threshold": THRESHOLD,
            "num_shares": NUM_SHARES,
            "coefficients": [
                {"x": all_shares[share_idx][i][0], "y": to_hex_bn254(all_shares[share_idx][i][1])}
                for i in range(N)
            ]
        }
        with open(share_path, "w") as f:
            json.dump(share_data, f)
        print(f"Share {share_idx + 1} saved to {share_path} ({os.path.getsize(share_path) / 1024:.1f} KB)")

    # Verify: reconstruct from shares 1,2 and check against sk
    print("\n=== Verification: reconstruct sk from shares 1,2 ===")
    for coeff_idx in range(N):
        recovered = shamir_reconstruct_field(
            [all_shares[0][coeff_idx], all_shares[1][coeff_idx]],
            THRESHOLD
        )
        assert recovered == sk_bn254[coeff_idx], f"Mismatch at coeff {coeff_idx}"
    print("Full reconstruction verified (all 1024 coefficients).")

    print("\n=== Done ===")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""RLWE decryption test: reconstruct sk from Shamir shares, decrypt ciphertext.

Uses ciphertext modulus q = 167772161 (same as ZKPayroll).
BFV convention: b = -(a*sk) + e_pk (mod q)
  c0 = (b*r + e1 + Delta*msg) mod q  (sparse, 64 slots)
  c1 = (a*r + e2) mod q              (full, 1024)
  Decrypt: (c0 + sk*c1) mod q = Delta*msg + noise
  Recover: msg[i] = round(noisy[i] / Delta) mod t
"""
import os
import json

N = 1024
MSG_SLOTS = 64
RLWE_Q = 167772161
PLAINTEXT_MOD = 256
DELTA = RLWE_Q // PLAINTEXT_MOD  # 655360
BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJ_DIR = os.path.dirname(BASE_DIR)
KEYS_DIR = os.path.join(PROJ_DIR, "demo-frontend", "public", "rlwe")


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


def shamir_reconstruct_field(shares, threshold):
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


def centered_mod(v, q):
    v = v % q
    if v > q // 2:
        v -= q
    return v


def main():
    # Step 1: Load Shamir shares and reconstruct sk
    print("=== Step 1: Reconstruct sk from shares 1, 2 ===")
    shares = []
    for idx in [1, 2]:
        path = os.path.join(KEYS_DIR, "rlwe_sk_shares", f"share_{idx}.json")
        with open(path) as f:
            data = json.load(f)
        shares.append(data)
    threshold = shares[0]["threshold"]

    # Reconstruct sk over BN254, then convert to mod q
    sk_bn254 = []
    for coeff_idx in range(N):
        s1 = (shares[0]["coefficients"][coeff_idx]["x"],
               int(shares[0]["coefficients"][coeff_idx]["y"], 16))
        s2 = (shares[1]["coefficients"][coeff_idx]["x"],
               int(shares[1]["coefficients"][coeff_idx]["y"], 16))
        val = shamir_reconstruct_field([s1, s2], threshold)
        sk_bn254.append(val)

    # Convert to mod q (small values: originally in [-3, 3])
    sk_mod_q = []
    for v in sk_bn254:
        # v is in BN254 field; if originally negative, v = BN254_P + original
        signed = centered_mod(v, BN254_P)
        sk_mod_q.append(signed % RLWE_Q)
    print(f"sk reconstructed: {N} coefficients")

    # Step 2: Load ciphertext
    print("\n=== Step 2: Load ciphertext ===")
    ct_path = os.path.join(KEYS_DIR, "ciphertext.json")
    with open(ct_path) as f:
        ct_data = json.load(f)
    c0_sparse = ct_data["c0_sparse"]  # already integers (mod q)
    c1 = ct_data["c1"]
    expected_owner_x = int(ct_data["expected_owner_x"], 16)
    expected_owner_y = int(ct_data["expected_owner_y"], 16)
    print(f"c0_sparse[0] = {c0_sparse[0]} (mod q={RLWE_Q})")

    # Step 3: Decrypt: (c0 + sk*c1) mod q = Delta*msg + noise
    print("\n=== Step 3: Decrypt ===")
    print("Computing sk * c1 (negacyclic mul mod q)...")
    sk_c1 = negacyclic_mul_mod_q(sk_mod_q, c1, N, RLWE_Q)

    msg_recovered = []
    for i in range(MSG_SLOTS):
        noisy = (c0_sparse[i] + sk_c1[i]) % RLWE_Q
        # Centered mod for correct rounding
        noisy_centered = centered_mod(noisy, RLWE_Q)
        # round(noisy / Delta) mod t
        val = round(noisy_centered / DELTA) % PLAINTEXT_MOD
        msg_recovered.append(val)

    print(f"\nRecovered msg slots (first 16):")
    for i in range(min(16, MSG_SLOTS)):
        print(f"  msg[{i:2d}] = {msg_recovered[i]:4d} (0x{msg_recovered[i]:02x})")

    # Step 4: Decode back to owner_x, owner_y (8-bit byte slots)
    print("\n=== Step 4: Decode owner_x, owner_y ===")
    recovered_owner_x = 0
    for i in range(32):
        recovered_owner_x += (msg_recovered[i] & 0xFF) << (i * 8)
    recovered_owner_y = 0
    for i in range(32):
        recovered_owner_y += (msg_recovered[32 + i] & 0xFF) << (i * 8)

    print(f"Expected  owner_x = {hex(expected_owner_x)}")
    print(f"Recovered owner_x = {hex(recovered_owner_x)}")
    print(f"Match: {recovered_owner_x == expected_owner_x}")

    print(f"\nExpected  owner_y = {hex(expected_owner_y)}")
    print(f"Recovered owner_y = {hex(recovered_owner_y)}")
    print(f"Match: {recovered_owner_y == expected_owner_y}")

    if recovered_owner_x == expected_owner_x and recovered_owner_y == expected_owner_y:
        print("\n=== DECRYPTION SUCCESSFUL ===")
    else:
        print("\n=== DECRYPTION FAILED ===")
        print("\nNoise analysis:")
        for i in range(MSG_SLOTS):
            expected = 0
            if i < 32:
                expected = (expected_owner_x >> (i * 8)) & 0xFF
            else:
                expected = (expected_owner_y >> ((i - 32) * 8)) & 0xFF
            print(f"  slot[{i:2d}]: expected={expected}, got={msg_recovered[i]}, diff={msg_recovered[i] - expected}")


if __name__ == "__main__":
    main()

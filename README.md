# Auditable dark pool 

**One-line description**<br>
Auditable dark pool on Solana: private SOL transfers with 2-of-3 auditable compliance via RLWE threshold decryption.

Submission for [Solana Privacy Hack](https://solana.com/privacyhack) (Jan 12 – Feb 2, 2026).

## Project Description

**Solana Auditable Dark Pool** is a compliance-first privacy solution enabling anonymous SOL transfers with an auditable identity for regulators. we implement a **2-of-3 Threshold Decryption** mechanism using RLWE encryption. While users maintain privacy from the public, designated auditors can recover transaction identities **if, and only if**, a threshold of auditors agree.

## Sponsor Technologies Used

- **Noir (Aztec):** Used to write ZK circuits (`noir_circuit` for withdrawal, `audit_circuit` for compliance proof).
- **Sunspot (Reilabs):** Utilized for compiling Noir circuits into Solana-compatible verifiers and generating proofs via the Go wrapper.
- **Helius RPC:** All Solana RPC interactions (deposits, withdrawals, state queries) are powered by Helius' high-performance devnet RPC infrastructure.

## 🪿 URLs
- Presentation Video: {승환님이 채우기}
- Demo: https://zk-rlwe-pool-solana.vercel.app/
- Demo Video: https://www.youtube.com/watch?v=N5k82fqNOAk

## Track

**Track — Private payments**  
Build innovative solutions for confidential or private transfers on Solana.

## Sponsor Bounties (applicable)

This project also qualifies for the following sponsor bounties:

- **Aztec** — ZK with Noir
- **Helius** — Best Privacy Project (leveraging Helius RPC for all Solana interactions)
- **Range** — Compliant Privacy


## Team

- [@Scarrots93](https://x.com/Scarrots93) — Team lead (Telegram: @Scarrots)
- [@ham379888](https://x.com/ham379888) — Development (Telegram: @Yunsikkkk)

## Technical Detail

**Core idea:** ZK for privacy + RLWE (FHE) for compliance. Two circuits share `wa_commitment` as the bridge: (1) Shielded Pool proves valid withdrawal; (2) RLWE Audit proves identity is correctly encrypted. No single party can decrypt; only 2-of-3 designated auditors can jointly recover identity via Shamir.

**Key mechanism:**
- `wa_commitment = Poseidon(owner_x, owner_y)` — shared public input linking both circuits
- Identity encrypted with RLWE; ZK proves encryption correctness on-chain
- Constant PK optimization: 42x fewer constraints (1.1M → 26K) via negacyclic row hardcoding

**Stack:** Noir · Sunspot · Pinocchio · BabyJubJub · RLWE + Shamir 2-of-3 · Poseidon · 🪿 Honk

**Flow:** Initialize (relayer) → Deposit (Merkle root update) → Withdraw (ZK + Audit proof verified on-chain)

**Next:** WASM proof gen, multi-asset (SPL), relayer network

**Telegram**
@Scarrots

---

*Disclaimer: Not audited. Use at your own risk.*

# Auditable dark pool

**One-line description**
Auditable dark pool on Solana: private SOL transfers with 2-of-3 auditable compliance via RLWE threshold decryption.

**GitHub**
https://github.com/Ham3798/shielded-pool-pinocchio-solana

**Presentation video**


**Live demo**
https://zk-rlwe-pool-solana.vercel.app/


**Track**


**Sponsor bounties**


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

For build, deploy, and full pipeline: see demo-frontend or run `pnpm --dir client run test-shielded-pool`.

# Shielded Pool

**One-line description**
Privacy-preserving SOL transfers on Solana using Noir ZK proofs with BabyJubJub auditable identity.

**GitHub**
https://github.com/Ham3798/shielded-pool-pinocchio-solana

**Presentation video**


**Live demo**


**Track**


**Sponsor bounties**


## Technical Detail

Shielded Pool is a ZK-based privacy pool for Solana that enables anonymous SOL transfers while maintaining auditability.

**Stack:**
- **Noir**: ZK circuit for proving valid withdrawals without revealing deposit details. The circuit verifies Merkle tree membership, nullifier uniqueness, and BabyJubJub identity ownership.
- **Sunspot**: Compiles Noir proofs to Solana-compatible Groth16 format for on-chain verification.
- **Pinocchio**: Lightweight Solana program framework for the pool and verifier contracts.
- **BabyJubJub**: Embedded curve on BN254 for auditable identity (wa_commitment), enabling future 2-of-3 threshold audit capability.
- **Poseidon Hash**: ZK-friendly hash for commitments, nullifiers, and Merkle tree construction.

**Commitment scheme:**
```
(owner_x, owner_y) = secret_key * G          // BabyJubJub
wa_commitment = Poseidon(owner_x, owner_y)   // Auditable identity
commitment = Poseidon(owner_x, owner_y, amount, randomness)
nullifier = Poseidon(secret_key, leaf_index)
```

## Roadmap

- Browser-based proof generation (WASM)
- 2-of-3 RLWE threshold audit module using wa_commitment
- Multi-asset support (SPL tokens)
- Relayer network for gas abstraction

**Telegram**


---

## Architecture

```
Shielded Pool
├─ noir_circuit/
│  ├─ nargo execute -> witness (.gz)
│  └─ sunspot prove -> proof (.proof) + public witness (.pw)
├─ verifier program (Sunspot Groth16)
│  └─ verifies proof + public witness
└─ shielded_pool_program/
   ├─ initialize/deposit/withdraw
   ├─ checks root/nullifier/recipient/amount
   └─ CPI to verifier program
```

***DISCLAIMER: This repository has not been audited. Use at your own risk.***

### Flow

1. **Initialize**: relayer creates state + vault PDAs
2. **Deposit**: sender transfers SOL into vault, updates Merkle root
3. **Withdraw**: relayer submits proof, program verifies, releases SOL to recipient

## Prerequisites

- [Nargo](https://noir-lang.org/docs/getting_started/noir_installation) `1.0.0-beta.13`
- [Sunspot](https://github.com/reilabs/sunspot) (Go 1.24+)
- [Solana CLI](https://solana.com/docs/intro/installation)
- Node.js 18+

```bash
# Noir
noirup -v 1.0.0-beta.13

# Sunspot
git clone https://github.com/reilabs/sunspot.git ~/sunspot
cd ~/sunspot/go && git checkout 5fd6223 && go build -o sunspot .
export PATH="$HOME/sunspot/go:$PATH"
export GNARK_VERIFIER_BIN="$HOME/sunspot/gnark-solana/crates/verifier-bin"
```

## Project Structure

```
.
├── noir_circuit/               # Noir circuit + proving artifacts
├── shielded_pool_program/      # Pinocchio program
├── client/                     # TS integration test
├── demo-frontend/              # Next.js demo UI
└── keypair/                    # Local keypairs (gitignored)
```

## Build and Deploy

### 1) Circuit artifacts

Pre-compiled artifacts (`.ccs`, `.pk`, `.vk`, `.json`) are included in the repository, so you can skip the compile and setup steps and go directly to proof generation.

**Quick start (using pre-compiled artifacts):**
```bash
cd noir_circuit
# Edit Prover.toml with your inputs
nargo execute
sunspot prove target/shielded_pool_verifier.json target/shielded_pool_verifier.gz target/shielded_pool_verifier.ccs target/shielded_pool_verifier.pk
sunspot deploy target/shielded_pool_verifier.vk
```

**Full build (if you need to regenerate artifacts):**
```bash
cd noir_circuit
nargo compile
nargo execute
sunspot compile target/shielded_pool_verifier.json
sunspot setup target/shielded_pool_verifier.ccs
sunspot prove target/shielded_pool_verifier.json target/shielded_pool_verifier.gz target/shielded_pool_verifier.ccs target/shielded_pool_verifier.pk
sunspot deploy target/shielded_pool_verifier.vk
```

### 2) Deploy verifier program

```bash
solana program deploy path/to/verifier.so --url devnet
```

### 3) Deploy shielded pool program

Update verifier program ID in `shielded_pool_program/src/instructions/withdraw.rs`, then:

```bash
cargo build-sbf --manifest-path shielded_pool_program/Cargo.toml
solana program deploy shielded_pool_program/target/deploy/shielded_pool_pinocchio.so --url devnet
```

## Run Integration Test

```bash
RPC_URL=https://api.devnet.solana.com \
ZK_VERIFIER_PROGRAM_ID=<verifier_program_id> \
SHIELDED_POOL_PROGRAM_ID=<shielded_pool_program_id> \
pnpm --dir client run test-shielded-pool
```

## Resources

- [Noir Documentation](https://noir-lang.org/docs/)
- [Sunspot Repository](https://github.com/reilabs/sunspot)
- [Pinocchio Library](https://github.com/anza-xyz/pinocchio)

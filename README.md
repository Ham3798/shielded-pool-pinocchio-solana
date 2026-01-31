# Shielded Pool (Noir + Pinocchio) on Solana

Private SOL transfers using a Noir circuit for proof generation and a Pinocchio-based on-chain program for deposit/withdraw logic. Proofs are verified on-chain via a Sunspot Groth16 verifier program.

## Architecture Overview

```
Shielded Pool (repo)
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

### Flow Summary

1) **Initialize**: relayer creates state + vault PDAs (fee payer = relayer).  
2) **Deposit**: sender transfers SOL into the vault and updates the Merkle root.  
3) **Withdraw**: relayer submits proof, program verifies the proof, consumes the nullifier, and releases SOL to the recipient.

Privacy comes from the ZK proof: the withdraw does not require the sender to sign, and the nullifier prevents double spend.

### Commitment Scheme (BabyJubJub-based Auditable Identity)

The circuit uses BabyJubJub-style elliptic curve for auditable identity:

- `(owner_x, owner_y) = secret_key * G` - BabyJubJub public key derivation
- `wa_commitment = Poseidon(owner_x, owner_y)` - Auditable identity for future RLWE audit module
- `commitment = Poseidon(owner_x, owner_y, amount, randomness)` - Note commitment
- `nullifier = Poseidon(secret_key, leaf_index)` - Double-spend prevention

The `wa_commitment` is a public input that can be logged on-chain for audit purposes.

#### Privacy Notes

This is **not** a full anonymity system for SOL transfers on its own. Practical privacy depends on:

- Pool size and volume (more deposits/withdrawals = larger anonymity set)
- Transaction frequency and timing correlation
- Unique wallet count interacting with the pool
- Delay between deposit and withdraw
- Fixed denominations (UI/UX should encourage standardized amounts)

## Prerequisites

- [Nargo](https://noir-lang.org/docs/getting_started/noir_installation) `1.0.0-beta.13`
- [Sunspot](https://github.com/reilabs/sunspot) (Go 1.24+)
- [Solana CLI](https://solana.com/docs/intro/installation)
- Node.js 18+ (for the client)

Example setup:

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
│   ├── src/main.nr
│   ├── Prover.toml
│   └── target/                 # .json/.ccs/.pk/.vk/.proof/.pw
├── shielded_pool_program/      # Pinocchio program (initialize/deposit/withdraw)
├── client/                     # TS integration test + helper scripts
└── keypair/                    # Local keypairs (ignored by git)
```

## Keypairs and Airdrop

Create the sender and relayer keypairs:

```bash
solana-keygen new --outfile keypair/sender.json --no-bip39-passphrase -s
solana-keygen new --outfile keypair/relayer.json --no-bip39-passphrase -s

solana airdrop 2 $(solana address -k keypair/sender.json) --url devnet
solana airdrop 2 $(solana address -k keypair/relayer.json) --url devnet
```

## Build and Deploy

### 1) Circuit artifacts (Noir + Sunspot)

If you modify the circuit or clone this repository for the first time, you need to generate the artifacts:

```bash
cd noir_circuit
nargo compile
nargo execute
sunspot compile target/shielded_pool_verifier.json
sunspot setup target/shielded_pool_verifier.ccs
sunspot prove target/shielded_pool_verifier.json target/shielded_pool_verifier.gz target/shielded_pool_verifier.ccs target/shielded_pool_verifier.pk
sunspot deploy target/shielded_pool_verifier.vk
```

`sunspot deploy` outputs a verifier program `.so` you can deploy to Solana.  

### 2) Deploy the verifier program

```bash
solana program deploy path/to/verifier.so --url devnet
```

### 3) Build & deploy the shielded pool program

Before building, update the verifier program ID in
`shielded_pool_program/src/instructions/withdraw.rs` to match the verifier you just deployed.

```bash
cargo build-sbf --manifest-path shielded_pool_program/Cargo.toml
solana program deploy shielded_pool_program/target/deploy/shielded_pool_pinocchio.so --url devnet
```

## Run the Integration Test

The client requires program IDs via env vars.

```bash
RPC_URL=https://api.devnet.solana.com \
ZK_VERIFIER_PROGRAM_ID=<verifier_program_id> \
SHIELDED_POOL_PROGRAM_ID=<shielded_pool_program_id> \
pnpm --dir client run test-shielded-pool
```

## Notes

- **Fee payer**: the relayer pays transaction fees for initialize/withdraw.  
- **Sender privacy**: the sender signs only the deposit. Withdraw uses proof verification and nullifier checks instead of a sender signature.
- **Proof size**: current proofs are 388 bytes, plus a 172-byte public witness (5 Field elements + 1 u64).
- **Secret key constraint**: secret_key must be <= 128 bits for Noir's EmbeddedCurveScalar compatibility.

## Resources

- [Noir Documentation](https://noir-lang.org/docs/)
- [Sunspot Repository](https://github.com/reilabs/sunspot)
- [Solana Noir Examples](https://github.com/solana-foundation/noir-examples)
- [Pinocchio Library](https://github.com/anza-xyz/pinocchio)

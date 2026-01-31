# Solana Shielded Pool Demo

ZK-proof based privacy pool with BabyJubJub auditable identity on Solana.

## Features

- **BabyJubJub Identity**: Elliptic curve-based identity for auditable privacy
- **Noir ZK Circuits**: Groth16 proofs compiled via Sunspot for Solana
- **Poseidon Hash**: ZK-friendly hash for commitments, nullifiers, and Merkle trees
- **wa_commitment**: Auditable identity for future 2-of-3 RLWE audit module

## Getting Started

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build
```

## Environment Variables

Create a `.env.local` file:

```env
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_SHIELDED_POOL_PROGRAM_ID=H76rmbsE6HxkDw7AWEJLtqYogyP6psq3Fk2wqPH7Cjes
NEXT_PUBLIC_ZK_VERIFIER_PROGRAM_ID=3qfJCYMTnPwFgSX1T3Ncem6b5DphHtNoMmgyVeb52Yti
```

## Deploy to Vercel

```bash
vercel login
vercel --prod
```

Set environment variables in Vercel dashboard.

## Technical Architecture

### Commitment Scheme

```
(owner_x, owner_y) = secret_key * G  // BabyJubJub generator
wa_commitment = Poseidon(owner_x, owner_y)
commitment = Poseidon(owner_x, owner_y, amount, randomness)
nullifier = Poseidon(secret_key, leaf_index)
```

### Program IDs (Devnet)

- **Pool**: `H76rmbsE6HxkDw7AWEJLtqYogyP6psq3Fk2wqPH7Cjes`
- **Verifier**: `3qfJCYMTnPwFgSX1T3Ncem6b5DphHtNoMmgyVeb52Yti`

## Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16, React 19, TypeScript |
| Styling | Tailwind CSS v4 |
| Solana Client | @solana/kit, @solana/react-hooks |
| ZK Hash | Poseidon (circomlibjs) |

## Contact

- Telegram: [@Scarrots](https://t.me/Scarrots)
- Telegram: [@Yunsikkkk](https://t.me/Yunsikkkk)
- GitHub: [Ham3798/shielded-pool-pinocchio-solana](https://github.com/Ham3798/shielded-pool-pinocchio-solana)

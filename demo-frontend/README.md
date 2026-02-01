# Demo Frontend

Shielded Pool demo web UI for the Auditable Dark Pool (🪿 Honk). See [project root README](../README.md) for main documentation.

## Run

```bash
npm install
npm run dev
```

## Environment Variables

`.env.local`:
```env
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_SHIELDED_POOL_PROGRAM_ID=H76rmbsE6HxkDw7AWEJLtqYogyP6psq3Fk2wqPH7Cjes
NEXT_PUBLIC_ZK_VERIFIER_PROGRAM_ID=3qfJCYMTnPwFgSX1T3Ncem6b5DphHtNoMmgyVeb52Yti
```

## Deploy

```bash
vercel --prod
```

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

## Withdraw 방법 (CLI-UI 하이브리드)

ZK proof는 브라우저에서 생성하지 않고, 로컬 CLI로 만든 뒤 UI에 붙여넣어 제출합니다.

### 전체 흐름

```
[브라우저] Deposit → [브라우저] CLI 안내 확인 → [CLI] proof 생성 → [브라우저] proof 붙여넣기 → Withdraw
```

### Step 1: Deposit (브라우저)

1. 지갑 연결 후 **Deposit SOL**에 금액 입력 (최소 0.001 SOL)
2. **Deposit** 버튼 클릭 → 트랜잭션 서명
3. 성공 시 **Step 2** 안내 블록이 나타남

### Step 2: Proof 생성 (로컬 CLI)

1. **Prover.toml 복사**  
   브라우저에 표시된 `Prover.toml` 내용 전체를 복사한 뒤, 프로젝트 루트의 `noir_circuit/Prover.toml`에 덮어쓰기.

2. **Noir 실행 + Sunspot prove**  
   터미널에서:
   ```bash
   cd noir_circuit
   nargo execute
   sunspot prove target/shielded_pool_verifier.json \
     target/shielded_pool_verifier.gz \
     target/shielded_pool_verifier.ccs \
     target/shielded_pool_verifier.pk
   ```
   생성 파일: `target/shielded_pool_verifier.proof`, `target/shielded_pool_verifier.pw`

3. **Proof/Witness를 hex로 변환**  
   프로젝트 루트에서:
   ```bash
   cd client
   npx tsx generate-proof-hex.ts
   ```
   터미널에 **Proof (hex)** 와 **Public Witness (hex)** 가 출력됨.

### Step 3: Withdraw (브라우저)

1. **Proof (hex)** 필드에 위에서 출력한 proof hex 붙여넣기
2. **Public Witness (hex)** 필드에 witness hex 붙여넣기
3. **Recipient Address** 확인 (기본값: 연결된 지갑 주소)
4. **Submit Withdraw** 클릭 → 트랜잭션 서명 후 출금 완료

### 요약 표

| 단계 | 위치 | 작업 |
|------|------|------|
| 1 | 브라우저 | Deposit → Prover.toml 내용 확인 |
| 2a | 로컬 | `noir_circuit/Prover.toml` 저장, `nargo execute` + `sunspot prove` |
| 2b | 로컬 | `client/generate-proof-hex.ts` 실행 → proof/witness hex 복사 |
| 3 | 브라우저 | proof·witness hex 붙여넣기 → Submit Withdraw |

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

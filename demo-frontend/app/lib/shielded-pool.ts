import { type Address, getAddressEncoder } from "@solana/kit";

// Program IDs (from environment or defaults)
export const SHIELDED_POOL_PROGRAM_ID =
  (process.env.NEXT_PUBLIC_SHIELDED_POOL_PROGRAM_ID as Address) ||
  ("H76rmbsE6HxkDw7AWEJLtqYogyP6psq3Fk2wqPH7Cjes" as Address);

export const ZK_VERIFIER_PROGRAM_ID =
  (process.env.NEXT_PUBLIC_ZK_VERIFIER_PROGRAM_ID as Address) ||
  ("3qfJCYMTnPwFgSX1T3Ncem6b5DphHtNoMmgyVeb52Yti" as Address);

export const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

export const INSTRUCTION = {
  INITIALIZE: 0,
  DEPOSIT: 1,
  WITHDRAW: 2,
} as const;

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Convert recipient pubkey to field element for ZK proof
 */
export function recipientFieldFromPubkey(pubkey: Address): string {
  const pubkeyBytes = getAddressEncoder().encode(pubkey);
  const trimmed = pubkeyBytes.slice(0, 30);
  const padded = new Uint8Array(32);
  padded[0] = 0;
  padded[1] = 0;
  padded.set(trimmed, 2);
  return (
    "0x" +
    Array.from(padded)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Audit log entry for display
 */
export interface AuditLogEntry {
  name: string;
  amount: bigint;
  waCommitment: string;
  nullifier: string;
  recipient: string;
  txSignature?: string;
}

/**
 * Demo payroll entry
 */
export interface PayrollEntry {
  name: string;
  amount: bigint;
  status: "pending" | "depositing" | "proving" | "withdrawing" | "completed";
}

export const DEMO_PAYROLL: PayrollEntry[] = [
  { name: "ALICE", amount: 1_000_000n, status: "pending" },
  { name: "CHARLIE", amount: 1_500_000n, status: "pending" },
  { name: "DAVID", amount: 1_000_000n, status: "pending" },
];

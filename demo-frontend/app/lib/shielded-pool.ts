import { type Address, getAddressDecoder, getAddressEncoder } from "@solana/kit";

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

/** Witness layout: 12-byte header + root(32) + nullifier(32) + recipient(32) + amount(32) + wa_commitment(32) */
const WITNESS_HEADER_LEN = 12;
const PUBLIC_INPUT_SIZE = 32;
const RECIPIENT_OFFSET = WITNESS_HEADER_LEN + PUBLIC_INPUT_SIZE * 2; // after root, nullifier

/**
 * Derive the Solana recipient address from the 32-byte recipient field in the public witness.
 * The circuit encodes only the first 30 bytes of the address (in field bytes [2..32]);
 * we use [0,0] for the last 2 bytes to get a canonical address.
 */
export function recipientAddressFromWitnessField(recipientField32: Uint8Array): Address {
  if (recipientField32.length !== 32) throw new Error("recipient field must be 32 bytes");
  const addressBytes = new Uint8Array(32);
  addressBytes.set(recipientField32.subarray(2, 32), 0);
  addressBytes[30] = 0;
  addressBytes[31] = 0;
  const [address] = getAddressDecoder().decode(addressBytes);
  return address as Address;
}

/**
 * Extract the 32-byte recipient field from full witness bytes (after 12-byte header + root + nullifier).
 */
export function getRecipientFieldFromWitness(witnessBytes: Uint8Array): Uint8Array {
  const start = RECIPIENT_OFFSET;
  const end = start + PUBLIC_INPUT_SIZE;
  if (witnessBytes.length < end) throw new Error("witness too short");
  return witnessBytes.slice(start, end);
}

/**
 * Derive Solana address (base58) from the recipient field hex string (0x + 64 hex) used in Prover.toml.
 */
export function recipientAddressFromFieldHex(fieldHex: string): Address {
  const clean = fieldHex.startsWith("0x") ? fieldHex.slice(2) : fieldHex;
  if (clean.length !== 64) throw new Error("recipient field must be 32 bytes (64 hex chars)");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return recipientAddressFromWitnessField(bytes);
}

/**
 * Return true if the given Solana address matches the recipient encoded in the witness.
 */
export function recipientMatchesWitness(address: Address, witnessBytes: Uint8Array): boolean {
  const recipientField = getRecipientFieldFromWitness(witnessBytes);
  const addressBytes = getAddressEncoder().encode(address);
  const expectedFirst30 = recipientField.subarray(2, 32);
  const actualFirst30 = addressBytes.subarray(0, 30);
  if (expectedFirst30.length !== 30 || actualFirst30.length !== 30) return false;
  return expectedFirst30.every((b, i) => b === actualFirst30[i]);
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

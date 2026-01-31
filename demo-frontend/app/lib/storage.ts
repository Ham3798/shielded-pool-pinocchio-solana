import { openDB, type DBSchema, type IDBPDatabase } from "idb";

// ============================================
// Types
// ============================================

export type DepositStatus = "pending" | "withdrawn";

export interface DepositRecord {
  id: string; // commitment hash (primary key)
  secretKey: string;
  publicKeyX: string;
  publicKeyY: string;
  amount: string; // stored as string for bigint serialization
  randomness: string;
  commitment: string;
  leafIndex: number;
  root: string;
  nullifier: string;
  waCommitment: string;
  siblings: string[];
  recipient: string;
  createdAt: number;
  status: DepositStatus;
  txSignature?: string;
  withdrawTxSignature?: string;
}

export interface MerkleTreeState {
  id: string; // 'current' - singleton
  leaves: string[];
  lastSyncedRoot: string;
  lastUpdated: number;
}

// ============================================
// IndexedDB Schema
// ============================================

interface ShieldedPoolDB extends DBSchema {
  deposits: {
    key: string;
    value: DepositRecord;
    indexes: {
      "by-status": DepositStatus;
      "by-created": number;
    };
  };
  merkleTree: {
    key: string;
    value: MerkleTreeState;
  };
}

const DB_NAME = "shielded-pool-demo";
const DB_VERSION = 1;

let dbInstance: IDBPDatabase<ShieldedPoolDB> | null = null;

// ============================================
// Database Initialization
// ============================================

async function getDB(): Promise<IDBPDatabase<ShieldedPoolDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<ShieldedPoolDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Deposits store
      if (!db.objectStoreNames.contains("deposits")) {
        const depositStore = db.createObjectStore("deposits", {
          keyPath: "id",
        });
        depositStore.createIndex("by-status", "status");
        depositStore.createIndex("by-created", "createdAt");
      }

      // Merkle tree state store
      if (!db.objectStoreNames.contains("merkleTree")) {
        db.createObjectStore("merkleTree", { keyPath: "id" });
      }
    },
  });

  return dbInstance;
}

// ============================================
// Deposit Operations
// ============================================

export async function saveDeposit(deposit: DepositRecord): Promise<void> {
  const db = await getDB();
  await db.put("deposits", deposit);
}

export async function getDeposit(id: string): Promise<DepositRecord | undefined> {
  const db = await getDB();
  return db.get("deposits", id);
}

export async function getAllDeposits(): Promise<DepositRecord[]> {
  const db = await getDB();
  const deposits = await db.getAllFromIndex("deposits", "by-created");
  // Return in reverse order (newest first)
  return deposits.reverse();
}

export async function getPendingDeposits(): Promise<DepositRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex("deposits", "by-status", "pending");
}

export async function getWithdrawnDeposits(): Promise<DepositRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex("deposits", "by-status", "withdrawn");
}

export async function updateDepositStatus(
  id: string,
  status: DepositStatus,
  withdrawTxSignature?: string
): Promise<void> {
  const db = await getDB();
  const deposit = await db.get("deposits", id);
  if (deposit) {
    deposit.status = status;
    if (withdrawTxSignature) {
      deposit.withdrawTxSignature = withdrawTxSignature;
    }
    await db.put("deposits", deposit);
  }
}

export async function deleteDeposit(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("deposits", id);
}

// ============================================
// Merkle Tree State Operations
// ============================================

const MERKLE_STATE_KEY = "current";

export async function saveMerkleTreeState(
  leaves: string[],
  lastSyncedRoot: string
): Promise<void> {
  const db = await getDB();
  const state: MerkleTreeState = {
    id: MERKLE_STATE_KEY,
    leaves,
    lastSyncedRoot,
    lastUpdated: Date.now(),
  };
  await db.put("merkleTree", state);
}

export async function getMerkleTreeState(): Promise<MerkleTreeState | undefined> {
  const db = await getDB();
  return db.get("merkleTree", MERKLE_STATE_KEY);
}

// ============================================
// Utility Functions
// ============================================

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  await db.clear("deposits");
  await db.clear("merkleTree");
}

export async function exportData(): Promise<{
  deposits: DepositRecord[];
  merkleTree: MerkleTreeState | undefined;
}> {
  const db = await getDB();
  const deposits = await db.getAll("deposits");
  const merkleTree = await db.get("merkleTree", MERKLE_STATE_KEY);
  return { deposits, merkleTree };
}

export async function importDeposits(deposits: DepositRecord[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("deposits", "readwrite");
  for (const deposit of deposits) {
    await tx.store.put(deposit);
  }
  await tx.done;
}

// ============================================
// Helper to create deposit record from form data
// ============================================

export interface CreateDepositParams {
  secretKey: bigint;
  publicKey: { x: bigint; y: bigint };
  amount: bigint;
  randomness: bigint;
  commitment: bigint;
  leafIndex: number;
  root: bigint;
  nullifier: bigint;
  waCommitment: bigint;
  siblings: bigint[];
  recipient: string;
  txSignature?: string;
}

export function createDepositRecord(params: CreateDepositParams): DepositRecord {
  const fieldToHex = (f: bigint): string =>
    "0x" + f.toString(16).padStart(64, "0");

  return {
    id: fieldToHex(params.commitment),
    secretKey: fieldToHex(params.secretKey),
    publicKeyX: fieldToHex(params.publicKey.x),
    publicKeyY: fieldToHex(params.publicKey.y),
    amount: params.amount.toString(),
    randomness: fieldToHex(params.randomness),
    commitment: fieldToHex(params.commitment),
    leafIndex: params.leafIndex,
    root: fieldToHex(params.root),
    nullifier: fieldToHex(params.nullifier),
    waCommitment: fieldToHex(params.waCommitment),
    siblings: params.siblings.map(fieldToHex),
    recipient: params.recipient,
    createdAt: Date.now(),
    status: "pending",
    txSignature: params.txSignature,
  };
}

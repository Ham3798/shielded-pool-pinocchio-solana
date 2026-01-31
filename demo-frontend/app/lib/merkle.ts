import { buildPoseidon, type Poseidon } from "circomlibjs";

let poseidonInstance: Poseidon | null = null;

export async function initPoseidon(): Promise<void> {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
}

function getPoseidon(): Poseidon {
  if (!poseidonInstance) {
    throw new Error("Poseidon not initialized. Call initPoseidon() first.");
  }
  return poseidonInstance;
}

export const TREE_DEPTH = 16;

export function poseidonHash2(left: bigint, right: bigint): bigint {
  const poseidon = getPoseidon();
  const hash = poseidon([left, right]);
  return poseidon.F.toObject(hash) as bigint;
}

export function poseidonHash4(
  v1: bigint,
  v2: bigint,
  v3: bigint,
  v4: bigint
): bigint {
  const poseidon = getPoseidon();
  const hash = poseidon([v1, v2, v3, v4]);
  return poseidon.F.toObject(hash) as bigint;
}

// ============================================
// BabyJubJub Identity (simplified for frontend)
// ============================================

export interface IdentityKeypair {
  secretKey: bigint;
  publicKey: {
    x: bigint;
    y: bigint;
  };
}

// Max 128-bit value (for EmbeddedCurveScalar compatibility)
const MAX_128_BIT = (1n << 128n) - 1n;

/**
 * Generate random 128-bit value
 */
export function randomField128(): bigint {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  let result = 0n;
  for (let i = 0; i < 16; i++) {
    result = (result << 8n) | BigInt(array[i]);
  }
  return result;
}

/**
 * Generate random 256-bit field element
 */
export function randomField(): bigint {
  const array = new Uint8Array(31);
  crypto.getRandomValues(array);
  let result = 0n;
  for (let i = 0; i < 31; i++) {
    result = (result << 8n) | BigInt(array[i]);
  }
  return result;
}

/**
 * Calculate wa_commitment = Poseidon(owner_x, owner_y)
 */
export function calculateWaCommitment(publicKey: {
  x: bigint;
  y: bigint;
}): bigint {
  return poseidonHash2(publicKey.x, publicKey.y);
}

/**
 * Calculate commitment = Poseidon(owner_x, owner_y, amount, randomness)
 */
export function calculateCommitment(
  publicKey: { x: bigint; y: bigint },
  amount: bigint,
  randomness: bigint
): bigint {
  return poseidonHash4(publicKey.x, publicKey.y, amount, randomness);
}

/**
 * Calculate nullifier = Poseidon(secret_key, leaf_index)
 */
export function calculateNullifier(
  secretKey: bigint,
  leafIndex: bigint
): bigint {
  return poseidonHash2(secretKey, leafIndex);
}

// ============================================
// Merkle Tree Implementation
// ============================================

export class ShieldedPoolMerkleTree {
  private leaves: bigint[] = [];
  private defaultHashes: bigint[] | null = null;

  private getDefaultHashes(): bigint[] {
    if (!this.defaultHashes) {
      this.defaultHashes = new Array(TREE_DEPTH + 1);
      this.defaultHashes[0] = 0n;
      for (let i = 1; i <= TREE_DEPTH; i++) {
        const prev = this.defaultHashes[i - 1];
        this.defaultHashes[i] = poseidonHash2(prev, prev);
      }
    }
    return this.defaultHashes;
  }

  constructor() {
    // Lazy initialization - defaultHashes computed on first use
  }

  insert(commitment: bigint): number {
    const index = this.leaves.length;
    this.leaves.push(commitment);
    return index;
  }

  getRoot(): bigint {
    const defaultHashes = this.getDefaultHashes();
    let currentLevel = [...this.leaves];
    for (let i = 0; i < TREE_DEPTH; i++) {
      const nextLevel: bigint[] = [];
      for (let j = 0; j < Math.pow(2, TREE_DEPTH - i); j += 2) {
        const left = currentLevel[j] ?? defaultHashes[i];
        const right = currentLevel[j + 1] ?? defaultHashes[i];
        nextLevel.push(poseidonHash2(left, right));
      }
      currentLevel = nextLevel;
    }
    return currentLevel[0];
  }

  getProof(index: number): bigint[] {
    const defaultHashes = this.getDefaultHashes();
    const proof: bigint[] = [];
    let currentIdx = index;
    let currentLevel = [...this.leaves];

    for (let i = 0; i < TREE_DEPTH; i++) {
      const isRight = currentIdx % 2 === 1;
      const siblingIdx = isRight ? currentIdx - 1 : currentIdx + 1;
      const sibling = currentLevel[siblingIdx] ?? defaultHashes[i];
      proof.push(sibling);

      const nextLevel: bigint[] = [];
      for (let j = 0; j < Math.pow(2, TREE_DEPTH - i); j += 2) {
        const left = currentLevel[j] ?? defaultHashes[i];
        const right = currentLevel[j + 1] ?? defaultHashes[i];
        nextLevel.push(poseidonHash2(left, right));
      }
      currentLevel = nextLevel;
      currentIdx = Math.floor(currentIdx / 2);
    }

    return proof;
  }

  getLeafCount(): number {
    return this.leaves.length;
  }
}

// ============================================
// Utility Functions
// ============================================

export function fieldToHex(f: bigint): string {
  return "0x" + f.toString(16).padStart(64, "0");
}

export function fieldToBytes(f: bigint): Uint8Array {
  const hex = f.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function u64ToLeBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

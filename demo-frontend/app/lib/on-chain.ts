import { type Address } from "@solana/kit";

// ============================================
// ShieldedPoolState Layout (1072 bytes total)
// ============================================
// offset 0:    discriminator [u8; 8]
// offset 8:    current_root [u8; 32]
// offset 40:   roots [[u8; 32]; 32]  (ring buffer of 32 roots)
// offset 1064: roots_index u32
// offset 1068: leaf_count u32

const DISCRIMINATOR_OFFSET = 0;
const DISCRIMINATOR_SIZE = 8;
const CURRENT_ROOT_OFFSET = 8;
const ROOT_SIZE = 32;
const ROOTS_OFFSET = 40;
const ROOTS_COUNT = 32;
const ROOTS_INDEX_OFFSET = 1064;
const LEAF_COUNT_OFFSET = 1068;
const STATE_SIZE = 1072;

// ============================================
// Types
// ============================================

export interface OnChainState {
  currentRoot: Uint8Array;
  roots: Uint8Array[];
  rootsIndex: number;
  leafCount: number;
}

export interface RootValidationResult {
  isValid: boolean;
  index: number | null; // position in ring buffer if valid
  isCurrent: boolean;
}

// ============================================
// State Parsing
// ============================================

export function parseShieldedPoolState(data: Uint8Array): OnChainState | null {
  if (data.length < STATE_SIZE) {
    console.error(`Invalid state data length: ${data.length}, expected ${STATE_SIZE}`);
    return null;
  }

  // Extract current root
  const currentRoot = data.slice(CURRENT_ROOT_OFFSET, CURRENT_ROOT_OFFSET + ROOT_SIZE);

  // Extract all roots from ring buffer
  const roots: Uint8Array[] = [];
  for (let i = 0; i < ROOTS_COUNT; i++) {
    const offset = ROOTS_OFFSET + i * ROOT_SIZE;
    roots.push(data.slice(offset, offset + ROOT_SIZE));
  }

  // Extract roots_index (little-endian u32)
  const rootsIndex =
    data[ROOTS_INDEX_OFFSET] |
    (data[ROOTS_INDEX_OFFSET + 1] << 8) |
    (data[ROOTS_INDEX_OFFSET + 2] << 16) |
    (data[ROOTS_INDEX_OFFSET + 3] << 24);

  // Extract leaf_count (little-endian u32)
  const leafCount =
    data[LEAF_COUNT_OFFSET] |
    (data[LEAF_COUNT_OFFSET + 1] << 8) |
    (data[LEAF_COUNT_OFFSET + 2] << 16) |
    (data[LEAF_COUNT_OFFSET + 3] << 24);

  return {
    currentRoot,
    roots,
    rootsIndex,
    leafCount,
  };
}

// ============================================
// Root Validation
// ============================================

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function isRootValid(
  state: OnChainState,
  root: Uint8Array
): RootValidationResult {
  // Check if it matches current root
  if (bytesEqual(state.currentRoot, root)) {
    return { isValid: true, index: state.rootsIndex, isCurrent: true };
  }

  // Check in ring buffer
  for (let i = 0; i < ROOTS_COUNT; i++) {
    if (bytesEqual(state.roots[i], root)) {
      return { isValid: true, index: i, isCurrent: false };
    }
  }

  return { isValid: false, index: null, isCurrent: false };
}

export function isRootValidFromHex(
  state: OnChainState,
  rootHex: string
): RootValidationResult {
  const root = hexToBytes(rootHex);
  return isRootValid(state, root);
}

// ============================================
// Utility Functions
// ============================================

export function bytesToHex(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function getCurrentRootHex(state: OnChainState): string {
  return bytesToHex(state.currentRoot);
}

// ============================================
// Fetching State (requires RPC)
// ============================================

export async function fetchShieldedPoolState(
  rpcUrl: string,
  stateAddress: Address
): Promise<OnChainState | null> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [
          stateAddress,
          { encoding: "base64" },
        ],
      }),
    });

    const result = await response.json();

    if (result.error) {
      console.error("RPC error:", result.error);
      return null;
    }

    if (!result.result?.value?.data) {
      console.error("Account not found or has no data");
      return null;
    }

    // Decode base64 data
    const base64Data = result.result.value.data[0];
    const binaryString = atob(base64Data);
    const data = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      data[i] = binaryString.charCodeAt(i);
    }

    return parseShieldedPoolState(data);
  } catch (error) {
    console.error("Failed to fetch shielded pool state:", error);
    return null;
  }
}

// ============================================
// Root Age Calculation
// ============================================

export function getRootAge(
  state: OnChainState,
  rootIndex: number
): number {
  // Calculate how many roots have been added since this root
  // rootsIndex points to the next position to write, so current is rootsIndex - 1
  const currentIndex = (state.rootsIndex - 1 + ROOTS_COUNT) % ROOTS_COUNT;

  if (rootIndex === currentIndex) {
    return 0; // Current root
  }

  // Calculate age (how many roots ago)
  let age = (currentIndex - rootIndex + ROOTS_COUNT) % ROOTS_COUNT;
  if (age === 0) age = ROOTS_COUNT; // Wrapped around completely

  return age;
}

export function isRootNearExpiry(
  state: OnChainState,
  rootIndex: number,
  threshold: number = 5
): boolean {
  const age = getRootAge(state, rootIndex);
  return age >= ROOTS_COUNT - threshold;
}

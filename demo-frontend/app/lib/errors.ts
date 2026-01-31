// ============================================
// Error Codes
// ============================================

export const ErrorCode = {
  POSEIDON_NOT_INITIALIZED: "POSEIDON_NOT_INITIALIZED",
  ROOT_EXPIRED: "ROOT_EXPIRED",
  NULLIFIER_ALREADY_USED: "NULLIFIER_ALREADY_USED",
  PROOF_PARSE_ERROR: "PROOF_PARSE_ERROR",
  WITNESS_PARSE_ERROR: "WITNESS_PARSE_ERROR",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  WALLET_NOT_CONNECTED: "WALLET_NOT_CONNECTED",
  TRANSACTION_FAILED: "TRANSACTION_FAILED",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  NETWORK_ERROR: "NETWORK_ERROR",
  INDEXEDDB_ERROR: "INDEXEDDB_ERROR",
  DEPOSIT_NOT_FOUND: "DEPOSIT_NOT_FOUND",
  INVALID_RECIPIENT: "INVALID_RECIPIENT",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================
// Error Messages
// ============================================

const ERROR_MESSAGES: Record<ErrorCodeType, string> = {
  [ErrorCode.POSEIDON_NOT_INITIALIZED]:
    "Poseidon hash function is not initialized",
  [ErrorCode.ROOT_EXPIRED]:
    "Merkle root has expired (no longer in valid roots ring buffer)",
  [ErrorCode.NULLIFIER_ALREADY_USED]: "This deposit has already been withdrawn",
  [ErrorCode.PROOF_PARSE_ERROR]: "Failed to parse ZK proof data",
  [ErrorCode.WITNESS_PARSE_ERROR]: "Failed to parse public witness data",
  [ErrorCode.INSUFFICIENT_FUNDS]: "Insufficient funds in shielded pool",
  [ErrorCode.WALLET_NOT_CONNECTED]: "Please connect your wallet first",
  [ErrorCode.TRANSACTION_FAILED]: "Transaction failed",
  [ErrorCode.INVALID_AMOUNT]: "Invalid deposit amount",
  [ErrorCode.NETWORK_ERROR]: "Network connection error",
  [ErrorCode.INDEXEDDB_ERROR]: "Failed to access local storage",
  [ErrorCode.DEPOSIT_NOT_FOUND]: "Deposit record not found",
  [ErrorCode.INVALID_RECIPIENT]: "Invalid recipient address",
};

// ============================================
// Recovery Hints
// ============================================

const RECOVERY_HINTS: Record<ErrorCodeType, string> = {
  [ErrorCode.POSEIDON_NOT_INITIALIZED]:
    "Please refresh the page and wait for initialization to complete",
  [ErrorCode.ROOT_EXPIRED]:
    "You need to create a new deposit. The Merkle tree has changed too much since your deposit.",
  [ErrorCode.NULLIFIER_ALREADY_USED]:
    "Check your transaction history. This deposit was already withdrawn.",
  [ErrorCode.PROOF_PARSE_ERROR]:
    "Make sure you copied the proof hex correctly. It should start with '0x'.",
  [ErrorCode.WITNESS_PARSE_ERROR]:
    "Make sure you copied the witness hex correctly. It should start with '0x'.",
  [ErrorCode.INSUFFICIENT_FUNDS]:
    "The pool doesn't have enough SOL. Wait for more deposits or contact support.",
  [ErrorCode.WALLET_NOT_CONNECTED]:
    "Click the 'Connect Wallet' button in the top right corner.",
  [ErrorCode.TRANSACTION_FAILED]:
    "Check your SOL balance for transaction fees. You can also try again.",
  [ErrorCode.INVALID_AMOUNT]:
    "Enter an amount greater than 0.001 SOL.",
  [ErrorCode.NETWORK_ERROR]:
    "Check your internet connection and try again.",
  [ErrorCode.INDEXEDDB_ERROR]:
    "Try clearing browser data or using a different browser.",
  [ErrorCode.DEPOSIT_NOT_FOUND]:
    "The deposit may have been deleted. Check if you have the Prover.toml backup.",
  [ErrorCode.INVALID_RECIPIENT]:
    "Enter a valid Solana address (base58 encoded, 32-44 characters).",
};

// ============================================
// Error Class
// ============================================

export class ShieldedPoolError extends Error {
  code: ErrorCodeType;
  recoveryHint: string;
  originalError?: Error;

  constructor(
    code: ErrorCodeType,
    message?: string,
    originalError?: Error
  ) {
    super(message || ERROR_MESSAGES[code]);
    this.name = "ShieldedPoolError";
    this.code = code;
    this.recoveryHint = RECOVERY_HINTS[code];
    this.originalError = originalError;
  }
}

// ============================================
// Helper Functions
// ============================================

export function getErrorMessage(code: ErrorCodeType): string {
  return ERROR_MESSAGES[code];
}

export function getRecoveryHint(code: ErrorCodeType): string {
  return RECOVERY_HINTS[code];
}

export function isShieldedPoolError(error: unknown): error is ShieldedPoolError {
  return error instanceof ShieldedPoolError;
}

export function parseTransactionError(error: unknown): ShieldedPoolError {
  const message = error instanceof Error ? error.message : String(error);

  // Check for common Solana/Program errors
  if (message.includes("NullifierAlreadyUsed") || message.includes("0x1770")) {
    return new ShieldedPoolError(ErrorCode.NULLIFIER_ALREADY_USED);
  }

  if (message.includes("InvalidRoot") || message.includes("0x1771")) {
    return new ShieldedPoolError(ErrorCode.ROOT_EXPIRED);
  }

  if (message.includes("insufficient") || message.includes("InsufficientFunds")) {
    return new ShieldedPoolError(ErrorCode.INSUFFICIENT_FUNDS);
  }

  if (message.includes("Proof verification failed")) {
    return new ShieldedPoolError(
      ErrorCode.PROOF_PARSE_ERROR,
      "ZK proof verification failed. Make sure you generated the proof correctly."
    );
  }

  // Generic transaction error
  return new ShieldedPoolError(
    ErrorCode.TRANSACTION_FAILED,
    message,
    error instanceof Error ? error : undefined
  );
}

// ============================================
// Status Types for UI
// ============================================

export type StatusType = "idle" | "loading" | "success" | "error" | "warning";

export interface StatusMessage {
  type: StatusType;
  message: string;
  hint?: string;
}

export function createStatus(
  type: StatusType,
  message: string,
  hint?: string
): StatusMessage {
  return { type, message, hint };
}

export function createErrorStatus(error: unknown): StatusMessage {
  if (isShieldedPoolError(error)) {
    return {
      type: "error",
      message: error.message,
      hint: error.recoveryHint,
    };
  }

  const message = error instanceof Error ? error.message : "Unknown error occurred";
  return {
    type: "error",
    message,
    hint: "Please try again or contact support if the issue persists.",
  };
}

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  useWalletConnection,
  useSendTransaction,
  useBalance,
} from "@solana/react-hooks";
import { getProgramDerivedAddress, type Address } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  initPoseidon,
  randomField128,
  randomField,
  generateIdentityKeypair,
  calculateWaCommitment,
  calculateCommitment,
  calculateNullifier,
  ShieldedPoolMerkleTree,
  fieldToHex,
  fieldToBytes,
  u64ToLeBytes,
  hexToField,
} from "../lib/merkle";
import {
  SHIELDED_POOL_PROGRAM_ID,
  ZK_VERIFIER_PROGRAM_ID,
  SYSTEM_PROGRAM_ADDRESS,
  INSTRUCTION,
  LAMPORTS_PER_SOL,
  recipientFieldFromPubkey,
} from "../lib/shielded-pool";
import {
  saveDeposit,
  getAllDeposits,
  updateDepositStatus,
  saveMerkleTreeState,
  getMerkleTreeState,
  createDepositRecord,
  type DepositRecord,
} from "../lib/storage";
import {
  fetchShieldedPoolState,
  isRootValidFromHex,
  getRootAge,
  isRootNearExpiry,
  type OnChainState,
  type RootValidationResult,
} from "../lib/on-chain";
import {
  ShieldedPoolError,
  ErrorCode,
  parseTransactionError,
  createStatus,
  createErrorStatus,
  type StatusMessage,
} from "../lib/errors";

// Helper function to convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Status colors
const STATUS_COLORS = {
  idle: "bg-cream/50 text-muted",
  loading: "bg-yellow-100 text-yellow-800 border-yellow-200",
  success: "bg-green-100 text-green-800 border-green-200",
  error: "bg-red-100 text-red-800 border-red-200",
  warning: "bg-orange-100 text-orange-800 border-orange-200",
};

export function ShieldedPoolCard() {
  const { wallet, status: walletStatus } = useWalletConnection();
  const { send, isSending } = useSendTransaction();

  const [amount, setAmount] = useState("");
  const [vaultAddress, setVaultAddress] = useState<Address | null>(null);
  const [stateAddress, setStateAddress] = useState<Address | null>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [isPoseidonReady, setIsPoseidonReady] = useState(false);
  const merkleTreeRef = useRef<ShieldedPoolMerkleTree | null>(null);

  // Deposits state
  const [deposits, setDeposits] = useState<DepositRecord[]>([]);
  const [selectedDeposit, setSelectedDeposit] = useState<DepositRecord | null>(null);
  const [showCliInstructions, setShowCliInstructions] = useState(false);

  // On-chain state
  const [onChainState, setOnChainState] = useState<OnChainState | null>(null);
  const [rootValidation, setRootValidation] = useState<RootValidationResult | null>(null);

  // Withdraw form state
  const [proofHex, setProofHex] = useState("");
  const [witnessHex, setWitnessHex] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");

  const walletAddress = wallet?.account.address;
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

  // Get or create merkle tree (only after Poseidon is ready)
  const getMerkleTree = useCallback(async () => {
    if (!isPoseidonReady) return null;

    if (!merkleTreeRef.current) {
      // Try to restore from IndexedDB
      const savedState = await getMerkleTreeState();
      if (savedState && savedState.leaves.length > 0) {
        const leaves = savedState.leaves.map(hexToField);
        merkleTreeRef.current = new ShieldedPoolMerkleTree(leaves);
      } else {
        merkleTreeRef.current = new ShieldedPoolMerkleTree();
      }
    }
    return merkleTreeRef.current;
  }, [isPoseidonReady]);

  // Initialize Poseidon
  useEffect(() => {
    initPoseidon().then(() => setIsPoseidonReady(true));
  }, []);

  // Load deposits from IndexedDB
  useEffect(() => {
    if (isPoseidonReady) {
      getAllDeposits().then(setDeposits);
    }
  }, [isPoseidonReady]);

  // Auto-fill recipient address
  useEffect(() => {
    if (walletAddress && !recipientAddress) {
      setRecipientAddress(walletAddress);
    }
  }, [walletAddress, recipientAddress]);

  // Derive PDAs when wallet connects
  useEffect(() => {
    async function derivePDAs() {
      const [vault] = await getProgramDerivedAddress({
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        seeds: [new TextEncoder().encode("vault")],
      });
      const [state] = await getProgramDerivedAddress({
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        seeds: [new TextEncoder().encode("pool_state")],
      });
      setVaultAddress(vault);
      setStateAddress(state);
    }
    derivePDAs();
  }, []);

  // Fetch on-chain state periodically
  useEffect(() => {
    if (!stateAddress) return;

    const fetchState = async () => {
      const state = await fetchShieldedPoolState(rpcUrl, stateAddress);
      if (state) {
        setOnChainState(state);
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 30000); // Every 30 seconds
    return () => clearInterval(interval);
  }, [stateAddress, rpcUrl]);

  // Validate selected deposit's root
  useEffect(() => {
    if (selectedDeposit && onChainState) {
      const result = isRootValidFromHex(onChainState, selectedDeposit.root);
      setRootValidation(result);
    } else {
      setRootValidation(null);
    }
  }, [selectedDeposit, onChainState]);

  // Get vault balance
  const vaultBalance = useBalance(vaultAddress ?? undefined);
  const vaultLamports = vaultBalance?.lamports ?? 0n;
  const vaultSol = Number(vaultLamports) / Number(LAMPORTS_PER_SOL);

  const handleDeposit = useCallback(async () => {
    if (!walletAddress || !vaultAddress || !stateAddress || !amount || !isPoseidonReady) {
      setStatusMessage(createStatus("error", "Missing required fields"));
      return;
    }

    const merkleTree = await getMerkleTree();
    if (!merkleTree) {
      setStatusMessage(createStatus("error", "Merkle tree not initialized"));
      return;
    }

    try {
      setStatusMessage(createStatus("loading", "Generating BabyJubJub identity..."));

      // Generate identity using proper BabyJubJub curve multiplication
      const secretKey = randomField128();
      const identity = generateIdentityKeypair(secretKey);
      const randomness = randomField();
      const depositAmount = BigInt(Math.floor(parseFloat(amount) * Number(LAMPORTS_PER_SOL)));

      if (depositAmount < 1000000n) {
        throw new ShieldedPoolError(ErrorCode.INVALID_AMOUNT, "Minimum deposit is 0.001 SOL");
      }

      // Calculate cryptographic values
      const waCommitment = calculateWaCommitment(identity.publicKey);
      const commitment = calculateCommitment(identity.publicKey, depositAmount, randomness);
      const index = merkleTree.insert(commitment);
      const root = merkleTree.getRoot();
      const nullifier = calculateNullifier(identity.secretKey, BigInt(index));
      const siblings = merkleTree.getProof(index);

      setStatusMessage(createStatus("loading", "Building deposit transaction..."));

      // Build deposit data
      const depositDataBytes = new Uint8Array(1 + 8 + 32 + 32);
      depositDataBytes[0] = INSTRUCTION.DEPOSIT;
      depositDataBytes.set(u64ToLeBytes(depositAmount), 1);
      depositDataBytes.set(fieldToBytes(commitment), 1 + 8);
      depositDataBytes.set(fieldToBytes(root), 1 + 8 + 32);

      const instruction = {
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        accounts: [
          { address: walletAddress, role: 3 },
          { address: stateAddress, role: 1 },
          { address: vaultAddress, role: 1 },
          { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
        ],
        data: depositDataBytes,
      };

      setStatusMessage(createStatus("loading", "Awaiting signature..."));

      const signature = await send({ instructions: [instruction] });

      // Create and save deposit record
      const recipientField = recipientFieldFromPubkey(walletAddress);
      const depositRecord = createDepositRecord({
        secretKey: identity.secretKey,
        publicKey: identity.publicKey,
        amount: depositAmount,
        randomness,
        commitment,
        leafIndex: index,
        root,
        nullifier,
        waCommitment,
        siblings,
        recipient: recipientField,
        txSignature: signature,
      });

      await saveDeposit(depositRecord);

      // Save merkle tree state
      const leaves = merkleTree.getLeaves().map(fieldToHex);
      await saveMerkleTreeState(leaves, fieldToHex(root));

      // Refresh on-chain state to reflect the new root
      const newState = await fetchShieldedPoolState(rpcUrl, stateAddress);
      if (newState) {
        setOnChainState(newState);
      }

      // Reload deposits
      const updatedDeposits = await getAllDeposits();
      setDeposits(updatedDeposits);

      // Select the new deposit and show CLI instructions
      setSelectedDeposit(depositRecord);
      setShowCliInstructions(true);

      setStatusMessage(
        createStatus(
          "success",
          `Deposited ${amount} SOL! TX: ${signature?.slice(0, 20)}... - See CLI instructions below`
        )
      );
      setAmount("");
    } catch (err) {
      console.error("Deposit failed:", err);
      setStatusMessage(createErrorStatus(err));
    }
  }, [walletAddress, vaultAddress, stateAddress, amount, isPoseidonReady, send, getMerkleTree, rpcUrl]);

  const handleWithdraw = useCallback(async () => {
    if (!walletAddress || !vaultAddress || !stateAddress) {
      setStatusMessage(createStatus("error", "Wallet not connected or missing addresses"));
      return;
    }

    if (!proofHex || !witnessHex || !recipientAddress) {
      setStatusMessage(
        createStatus("error", "Please fill in all withdraw fields (proof, witness, recipient)")
      );
      return;
    }

    try {
      setStatusMessage(createStatus("loading", "Parsing proof data..."));

      // Validate hex format
      if (!proofHex.startsWith("0x") || proofHex.length < 10) {
        throw new ShieldedPoolError(ErrorCode.PROOF_PARSE_ERROR);
      }
      if (!witnessHex.startsWith("0x") || witnessHex.length < 10) {
        throw new ShieldedPoolError(ErrorCode.WITNESS_PARSE_ERROR);
      }

      // Convert hex to bytes
      const proofBytes = hexToBytes(proofHex);
      const witnessBytes = hexToBytes(witnessHex);

      // Extract nullifier from witness (12 byte header + first 32 bytes after header is root, next 32 is nullifier)
      const WITNESS_HEADER_LEN = 12;
      const nullifierBytes = witnessBytes.slice(
        WITNESS_HEADER_LEN + 32,
        WITNESS_HEADER_LEN + 64
      );

      // Derive nullifier PDA
      const [nullifierPda] = await getProgramDerivedAddress({
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        seeds: [new TextEncoder().encode("nullifier"), nullifierBytes],
      });

      setStatusMessage(createStatus("loading", "Building withdraw transaction..."));

      // Build withdraw instruction data: [WITHDRAW, proof, witness]
      const data = new Uint8Array(1 + proofBytes.length + witnessBytes.length);
      data[0] = INSTRUCTION.WITHDRAW;
      data.set(proofBytes, 1);
      data.set(witnessBytes, 1 + proofBytes.length);

      const withdrawIx = {
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        accounts: [
          { address: walletAddress, role: 3 },
          { address: recipientAddress as Address, role: 1 },
          { address: vaultAddress, role: 1 },
          { address: stateAddress, role: 1 },
          { address: nullifierPda, role: 1 },
          { address: ZK_VERIFIER_PROGRAM_ID, role: 0 },
          { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
        ],
        data,
      };

      setStatusMessage(
        createStatus("loading", "Awaiting signature... (ZK proof verification on-chain)")
      );

      const signature = await send({
        instructions: [
          getSetComputeUnitLimitInstruction({ units: 600_000 }),
          withdrawIx,
        ],
      });

      // Update deposit status if we have a selected deposit
      if (selectedDeposit) {
        await updateDepositStatus(selectedDeposit.id, "withdrawn", signature);
        const updatedDeposits = await getAllDeposits();
        setDeposits(updatedDeposits);
      }

      setStatusMessage(createStatus("success", `Withdraw successful! TX: ${signature?.slice(0, 20)}...`));
      setProofHex("");
      setWitnessHex("");
      setSelectedDeposit(null);
      setShowCliInstructions(false);
    } catch (err) {
      console.error("Withdraw failed:", err);
      const error = parseTransactionError(err);
      setStatusMessage(createErrorStatus(error));
    }
  }, [walletAddress, vaultAddress, stateAddress, proofHex, witnessHex, recipientAddress, send, selectedDeposit]);

  // Generate Prover.toml content
  const generateProverToml = useCallback((deposit: DepositRecord) => {
    let toml = `# Prover.toml - Copy this to noir_circuit/Prover.toml\n`;
    toml += `root = "${deposit.root}"\n`;
    toml += `nullifier = "${deposit.nullifier}"\n`;
    toml += `recipient = "${deposit.recipient}"\n`;
    toml += `amount = ${deposit.amount}\n`;
    toml += `wa_commitment = "${deposit.waCommitment}"\n`;
    toml += `secret_key = "${deposit.secretKey}"\n`;
    toml += `owner_x = "${deposit.publicKeyX}"\n`;
    toml += `owner_y = "${deposit.publicKeyY}"\n`;
    toml += `randomness = "${deposit.randomness}"\n`;
    toml += `index = ${deposit.leafIndex}\n`;
    toml += `siblings = [\n`;
    for (const sib of deposit.siblings) {
      toml += `  "${sib}",\n`;
    }
    toml += `]\n`;
    return toml;
  }, []);

  // Generate full CLI commands
  const generateCliCommands = useCallback(() => {
    return `# Step 1: Install prerequisites (if not already done)
# Noir
noirup -v 1.0.0-beta.13

# Sunspot (must use commit 5fd6223 for Noir compatibility)
git clone https://github.com/reilabs/sunspot.git ~/sunspot
cd ~/sunspot && git checkout 5fd6223
cd go && go build -o sunspot .
export PATH="$HOME/sunspot/go:$PATH"

# Step 2: Clone repository (if not already done)
git clone https://github.com/Ham3798/shielded-pool-pinocchio-solana.git
cd shielded-pool-pinocchio-solana

# Step 3: Generate proof
cd noir_circuit
# Copy Prover.toml content from above to noir_circuit/Prover.toml
nargo execute
sunspot prove target/shielded_pool_verifier.json \\
  target/shielded_pool_verifier.gz \\
  target/shielded_pool_verifier.ccs \\
  target/shielded_pool_verifier.pk

# Step 4: Convert to hex
cd ../client
npx tsx generate-proof-hex.ts`;
  }, []);

  const pendingDeposits = deposits.filter((d) => d.status === "pending");

  if (walletStatus !== "connected") {
    return (
      <section className="w-full max-w-3xl space-y-4 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
        <div className="space-y-1">
          <p className="text-lg font-semibold">Shielded Pool</p>
          <p className="text-sm text-muted">
            Connect your wallet to interact with the privacy pool.
          </p>
        </div>
        <div className="rounded-lg bg-cream/50 p-4 text-center text-sm text-muted">
          Wallet not connected
        </div>
      </section>
    );
  }

  return (
    <section className="w-full max-w-3xl space-y-4 rounded-2xl border border-border-low bg-card p-6 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-lg font-semibold">Shielded Pool</p>
          <p className="text-sm text-muted">
            Privacy-preserving SOL transfers with ZK proofs and BabyJubJub identity.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
            isPoseidonReady
              ? "bg-green-100 text-green-800"
              : "bg-yellow-100 text-yellow-800"
          }`}
        >
          {isPoseidonReady ? "Ready" : "Loading..."}
        </span>
      </div>

      {/* Pool Balance & On-chain State */}
      <div className="rounded-xl border border-border-low bg-cream/30 p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">Pool Balance</p>
            <p className="mt-1 text-3xl font-bold tabular-nums">
              {vaultSol.toFixed(4)}{" "}
              <span className="text-lg font-normal text-muted">SOL</span>
            </p>
          </div>
          {onChainState && (
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-muted">On-chain Leaves</p>
              <p className="mt-1 text-lg font-semibold">{onChainState.leafCount}</p>
            </div>
          )}
        </div>
        {vaultAddress && (
          <p className="mt-2 truncate font-mono text-xs text-muted">
            Vault: {vaultAddress}
          </p>
        )}
      </div>

      {/* Pending Deposits List */}
      {pendingDeposits.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Your Pending Deposits ({pendingDeposits.length})
          </p>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-border-low">
            {pendingDeposits.map((deposit) => {
              const isSelected = selectedDeposit?.id === deposit.id;
              const amountSol = Number(deposit.amount) / 1e9;
              let rootStatus = null;
              if (onChainState) {
                const validation = isRootValidFromHex(onChainState, deposit.root);
                if (validation.isValid) {
                  const age = validation.index !== null ? getRootAge(onChainState, validation.index) : 0;
                  const nearExpiry = validation.index !== null && isRootNearExpiry(onChainState, validation.index);
                  rootStatus = nearExpiry ? (
                    <span className="text-xs text-orange-600">Root expiring soon</span>
                  ) : (
                    <span className="text-xs text-green-600">Root valid (age: {age})</span>
                  );
                } else {
                  rootStatus = <span className="text-xs text-red-600">Root expired</span>;
                }
              }
              return (
                <button
                  key={deposit.id}
                  onClick={() => {
                    setSelectedDeposit(isSelected ? null : deposit);
                    setShowCliInstructions(!isSelected);
                  }}
                  className={`w-full flex items-center justify-between px-4 py-3 text-left border-b border-border-low/50 last:border-0 transition hover:bg-cream/50 ${
                    isSelected ? "bg-cream" : ""
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                        isSelected
                          ? "bg-foreground border-foreground"
                          : "border-muted"
                      }`}
                    >
                      {isSelected && (
                        <svg
                          className="w-3 h-3 text-background"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                    <div>
                      <span className="font-mono font-medium">
                        {amountSol.toFixed(4)} SOL
                      </span>
                      <span className="ml-2 text-xs text-muted">
                        Index: {deposit.leafIndex}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {rootStatus}
                    <span className="text-xs text-muted">
                      {new Date(deposit.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Deposit Form */}
      <div className="space-y-3">
        <p className="text-sm font-medium">Step 1: Deposit SOL</p>
        <div className="flex gap-3">
          <input
            type="number"
            min="0"
            step="0.001"
            placeholder="Amount in SOL (min 0.001)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={isSending || !isPoseidonReady}
            className="flex-1 rounded-lg border border-border-low bg-card px-4 py-2.5 text-sm outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            onClick={handleDeposit}
            disabled={isSending || !amount || parseFloat(amount) < 0.001 || !isPoseidonReady}
            className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSending ? "Confirming..." : "Deposit"}
          </button>
        </div>
        <p className="text-xs text-muted">
          Deposits create a ZK commitment using BabyJubJub curve. After deposit, follow CLI
          instructions to generate proof.
        </p>
      </div>

      {/* CLI Instructions (shown when deposit is selected) */}
      {showCliInstructions && selectedDeposit && (
        <div className="space-y-3 rounded-xl border border-border-low bg-cream/20 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Step 2: Generate ZK Proof (CLI)</p>
            <button
              onClick={() => setShowCliInstructions(false)}
              className="text-xs text-muted hover:text-foreground"
            >
              Hide
            </button>
          </div>

          {/* Root Status Warning */}
          {rootValidation && !rootValidation.isValid && (
            <div className="rounded-lg bg-red-100 border border-red-200 px-4 py-3 text-sm text-red-800">
              <strong>Warning:</strong> This deposit&apos;s root has expired. You need to create a
              new deposit.
            </div>
          )}

          {rootValidation && rootValidation.isValid && rootValidation.index !== null && onChainState && isRootNearExpiry(onChainState, rootValidation.index) && (
            <div className="rounded-lg bg-orange-100 border border-orange-200 px-4 py-3 text-sm text-orange-800">
              <strong>Warning:</strong> This root is near expiry. Generate and submit proof
              soon.
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted">1. Copy Prover.toml content:</p>
              <button
                onClick={() => navigator.clipboard.writeText(generateProverToml(selectedDeposit))}
                className="rounded bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90"
              >
                Copy Prover.toml
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-card p-3 text-xs font-mono max-h-48">
              {generateProverToml(selectedDeposit)}
            </pre>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted">2. Run commands in terminal:</p>
              <button
                onClick={() => navigator.clipboard.writeText(generateCliCommands())}
                className="rounded bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90"
              >
                Copy All Commands
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-card p-3 text-xs font-mono">
              {generateCliCommands()}
            </pre>
          </div>

          <div className="rounded-lg bg-cream/50 p-3 text-xs text-muted space-y-1">
            <p className="font-medium text-foreground">Requirements:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Noir (nargo) v1.0.0-beta.13 - ZK circuit compiler</li>
              <li>Sunspot commit 5fd6223 - Solana proof generator (Go 1.24+)</li>
              <li>Node.js 18+ - For hex conversion script</li>
            </ul>
          </div>
        </div>
      )}

      {/* Withdraw Form */}
      <div className="space-y-3 border-t border-border-low pt-4">
        <p className="text-sm font-medium">Step 3: Withdraw with ZK Proof</p>

        <div className="space-y-2">
          <label className="text-xs text-muted">Proof (hex):</label>
          <textarea
            placeholder="0x... (paste proof hex from CLI)"
            value={proofHex}
            onChange={(e) => setProofHex(e.target.value)}
            disabled={isSending}
            rows={2}
            className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 text-xs font-mono outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs text-muted">Public Witness (hex):</label>
          <textarea
            placeholder="0x... (paste witness hex from CLI)"
            value={witnessHex}
            onChange={(e) => setWitnessHex(e.target.value)}
            disabled={isSending}
            rows={2}
            className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 text-xs font-mono outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs text-muted">Recipient Address:</label>
          <input
            type="text"
            placeholder="Solana address"
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
            disabled={isSending}
            className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 text-xs font-mono outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <button
          onClick={handleWithdraw}
          disabled={isSending || !proofHex || !witnessHex || !recipientAddress}
          className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSending ? "Verifying & Withdrawing..." : "Submit Withdraw"}
        </button>
      </div>

      {/* Status Message */}
      {statusMessage && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${STATUS_COLORS[statusMessage.type]}`}
        >
          <p>{statusMessage.message}</p>
          {statusMessage.hint && (
            <p className="mt-1 text-xs opacity-80">{statusMessage.hint}</p>
          )}
        </div>
      )}

      {/* Withdrawn Deposits History */}
      {deposits.filter((d) => d.status === "withdrawn").length > 0 && (
        <div className="space-y-2 border-t border-border-low pt-4">
          <p className="text-sm font-medium">Withdrawal History</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-low">
                  <th className="pb-2 text-left font-medium text-muted">Amount</th>
                  <th className="pb-2 text-left font-medium text-muted">wa_commitment</th>
                  <th className="pb-2 text-left font-medium text-muted">Date</th>
                </tr>
              </thead>
              <tbody>
                {deposits
                  .filter((d) => d.status === "withdrawn")
                  .map((deposit) => (
                    <tr key={deposit.id} className="border-b border-border-low/50">
                      <td className="py-2 font-mono">
                        {(Number(deposit.amount) / 1e9).toFixed(4)} SOL
                      </td>
                      <td className="py-2 font-mono text-muted">
                        {deposit.waCommitment.slice(0, 22)}...
                      </td>
                      <td className="py-2 text-muted">
                        {new Date(deposit.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Technical Info */}
      <div className="border-t border-border-low pt-4 text-xs text-muted">
        <p className="mb-2">
          This is a <span className="font-semibold">ZK-proof based privacy pool</span> with
          BabyJubJub auditable identity, built for the Solana ecosystem.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href="https://github.com/Ham3798/shielded-pool-pinocchio-solana"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-cream px-2 py-1 font-medium transition hover:bg-cream/70"
          >
            GitHub
          </a>
          <span className="rounded-md bg-cream/50 px-2 py-1 font-mono">
            Noir + Pinocchio
          </span>
          <span className="rounded-md bg-cream/50 px-2 py-1 font-mono">BabyJubJub</span>
          <span className="rounded-md bg-cream/50 px-2 py-1 font-mono">Poseidon Hash</span>
        </div>
      </div>
    </section>
  );
}

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
  AUDIT_VERIFIER_PROGRAM_ID, // ## SH ##
} from "../lib/shielded-pool";
import {
  saveDeposit,
  getAllDeposits,
  updateDepositStatus,
  saveMerkleTreeState,
  getMerkleTreeState,
  createDepositRecord,
  saveAuditLog,
  getAllAuditLogs,
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
// ## SH START ##
import {
  rlweEncrypt,
  computeQuotients,
} from "../lib/rlwe";
import { decryptFromShares } from "../lib/shamir";
// ## SH END ##

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
  // ## SH START ##
  const [isProcessing, setIsProcessing] = useState(false); // covers full deposit/withdraw flow
  // ## SH END ##
  const merkleTreeRef = useRef<ShieldedPoolMerkleTree | null>(null);

  // Deposits state
  const [deposits, setDeposits] = useState<DepositRecord[]>([]);
  const [selectedDeposit, setSelectedDeposit] = useState<DepositRecord | null>(null);
  const [showCliInstructions, setShowCliInstructions] = useState(false);
  const [showBackendSetup, setShowBackendSetup] = useState(false);

  // On-chain state
  const [onChainState, setOnChainState] = useState<OnChainState | null>(null);
  const [rootValidation, setRootValidation] = useState<RootValidationResult | null>(null);

  // Withdraw form state
  const [proofHex, setProofHex] = useState("");
  const [witnessHex, setWitnessHex] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");

  // ## SH START ##
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [decryptedIdentity, setDecryptedIdentity] = useState<{
    ownerX: bigint;
    ownerY: bigint;
  } | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [hoveredNullifier, setHoveredNullifier] = useState<string | null>(null);
  const [auditProofHex, setAuditProofHex] = useState("");
  const [auditWitnessHex, setAuditWitnessHex] = useState("");
  const [auditLogs, setAuditLogs] = useState<{
    nullifier: string;
    waCommitment: string;
    ctCommitment: string;
    txSignature: string;
    timestamp: number;
    bjjX?: string;
    bjjY?: string;
  }[]>([]);
  const [relayerStatus, setRelayerStatus] = useState<{
    relayerAddress: string;
    balanceSol: number;
    lowBalance: boolean;
  } | null>(null);
  // ## SH END ##

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

  // Load deposits and audit logs from IndexedDB
  useEffect(() => {
    if (isPoseidonReady) {
      getAllDeposits().then(setDeposits);
      getAllAuditLogs().then((logs) =>
        setAuditLogs(logs.map((l) => ({
          nullifier: l.nullifier ?? "",
          waCommitment: l.waCommitment,
          ctCommitment: l.ctCommitment,
          txSignature: l.txSignature,
          timestamp: l.timestamp,
          bjjX: l.bjjX,
          bjjY: l.bjjY,
        })))
      );
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
    const interval = setInterval(fetchState, 30000);
    return () => clearInterval(interval);
  }, [stateAddress, rpcUrl]);

  // Fetch relayer status
  useEffect(() => {
    const fetchRelayer = async () => {
      try {
        const res = await fetch("/api/relay/status");
        if (res.ok) {
          const data = await res.json();
          setRelayerStatus({
            relayerAddress: data.relayerAddress,
            balanceSol: data.balanceSol,
            lowBalance: data.lowBalance,
          });
        } else {
          setRelayerStatus(null);
        }
      } catch {
        setRelayerStatus(null);
      }
    };
    fetchRelayer();
    const interval = setInterval(fetchRelayer, 60000);
    return () => clearInterval(interval);
  }, []);

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
    setIsProcessing(true); // ## SH ##

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

      // ## SH START ##
      // RLWE encrypt (owner_x, owner_y) for audit
      try {
        setStatusMessage(createStatus("loading", "Encrypting identity (RLWE)..."));
        const enc = await rlweEncrypt(identity.publicKey.x, identity.publicKey.y);
        const quotients = await computeQuotients(
          enc.c0Sparse, enc.c1, enc.rSigned, enc.e1Signed, enc.e2Signed, enc.msg
        );
        const fmtQ = (v: bigint) => {
          const mod = ((v % 167772161n) + 167772161n) % 167772161n;
          return "0x" + mod.toString(16).padStart(64, "0");
        };
        const fmtBn = (v: number | bigint) => {
          const bn254p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
          const vb = ((BigInt(v) % bn254p) + bn254p) % bn254p;
          if (vb === 0n) return "0x" + "0".padStart(64, "0");
          return "0x" + vb.toString(16).padStart(64, "0");
        };
        depositRecord.rlweCiphertext = {
          c0Sparse: enc.c0Sparse.map(fmtQ),
          c1: enc.c1.map(fmtQ),
        };
        depositRecord.rlweNoise = {
          r: enc.rSigned.map((v) => fmtBn(v)),
          e1Sparse: enc.e1Signed.map((v) => fmtBn(v)),
          e2: enc.e2Signed.map((v) => fmtBn(v)),
        };
        depositRecord.rlweQuotients = {
          k0: quotients.k0.map((v) => fmtBn(v)),
          k1: quotients.k1.map((v) => fmtBn(v)),
        };
      } catch (rlweErr) {
        console.error("RLWE encryption failed (non-fatal):", rlweErr);
      }
      // ## SH END ##

      await saveDeposit(depositRecord);

      // Save merkle tree state
      const leaves = merkleTree.getLeaves().map(fieldToHex);
      await saveMerkleTreeState(leaves, fieldToHex(root));

      // Refresh on-chain state to reflect the new root (delay for RPC propagation)
      await new Promise((r) => setTimeout(r, 3000));
      const newState = await fetchShieldedPoolState(rpcUrl, stateAddress);
      if (newState) {
        setOnChainState(newState);
      }
      // Retry with increasing delays until root is found
      for (const delay of [5000, 7000]) {
        const curState = await fetchShieldedPoolState(rpcUrl, stateAddress);
        if (curState) setOnChainState(curState);
        if (curState && isRootValidFromHex(curState, fieldToHex(root)).isValid) break;
        await new Promise((r) => setTimeout(r, delay));
        const retryState = await fetchShieldedPoolState(rpcUrl, stateAddress);
        if (retryState) setOnChainState(retryState);
        if (retryState && isRootValidFromHex(retryState, fieldToHex(root)).isValid) break;
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
    } finally {
      setIsProcessing(false); // ## SH ##
    }
  }, [walletAddress, vaultAddress, stateAddress, amount, isPoseidonReady, send, getMerkleTree, rpcUrl]);

  const handleWithdraw = useCallback(async () => {
    if (!vaultAddress || !stateAddress) {
      setStatusMessage(createStatus("error", "Missing pool addresses"));
      return;
    }

    if (!proofHex || !witnessHex || !auditProofHex || !auditWitnessHex || !recipientAddress) {
      setStatusMessage(
        createStatus("error", "Please fill in all fields (withdraw proof, witness, audit proof, audit witness, recipient)")
      );
      return;
    }

    try {
      setStatusMessage(createStatus("loading", "Validating proof data..."));

      // Validate hex format for withdraw proof/witness
      if (!proofHex.startsWith("0x") || proofHex.length < 10) {
        throw new ShieldedPoolError(ErrorCode.PROOF_PARSE_ERROR);
      }
      if (!witnessHex.startsWith("0x") || witnessHex.length < 10) {
        throw new ShieldedPoolError(ErrorCode.WITNESS_PARSE_ERROR);
      }
      // Validate hex format for audit proof/witness
      if (!auditProofHex.startsWith("0x") || auditProofHex.length < 10) {
        throw new ShieldedPoolError(ErrorCode.PROOF_PARSE_ERROR, "Invalid audit proof format");
      }
      if (!auditWitnessHex.startsWith("0x") || auditWitnessHex.length < 10) {
        throw new ShieldedPoolError(ErrorCode.WITNESS_PARSE_ERROR, "Invalid audit witness format");
      }

      // Convert hex to bytes to extract nullifier
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

      setStatusMessage(createStatus("loading", "Submitting to relayer..."));

      // Call relayer API
      const response = await fetch("/api/relay/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientAddress,
          nullifierPda,
          withdrawProofHex: proofHex,
          withdrawWitnessHex: witnessHex,
          auditProofHex,
          auditWitnessHex,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Relayer request failed");
      }

      // Update deposit status if we have a selected deposit
      if (selectedDeposit) {
        await updateDepositStatus(selectedDeposit.id, "withdrawn", result.signature);
        const updatedDeposits = await getAllDeposits();
        setDeposits(updatedDeposits);
      }

      setStatusMessage(
        createStatus("success", `Withdraw via relayer! TX: ${result.signature?.slice(0, 20)}... (Relayer: ${result.relayerAddress?.slice(0, 8)}...)`)
      );
      setProofHex("");
      setWitnessHex("");
      setAuditProofHex("");
      setAuditWitnessHex("");
      setSelectedDeposit(null);
      setShowCliInstructions(false);
    } catch (err) {
      console.error("Withdraw failed:", err);
      const error = parseTransactionError(err);
      setStatusMessage(createErrorStatus(error));
    }
  }, [vaultAddress, stateAddress, proofHex, witnessHex, auditProofHex, auditWitnessHex, recipientAddress, selectedDeposit]);

  // Generate Prover.toml content
  // IMPORTANT: recipient in proof must match Recipient Address submitted at withdraw.
  // Use recipientAddress (withdraw target) when valid; else deposit.recipient (depositor at deposit time).
  const generateProverToml = useCallback(
    (deposit: DepositRecord) => {
      let recipientField = deposit.recipient;
      if (recipientAddress && recipientAddress.length >= 32 && recipientAddress.length <= 44) {
        try {
          recipientField = recipientFieldFromPubkey(recipientAddress as Address);
        } catch {
          // Invalid address, fall back to deposit.recipient
        }
      }
      let toml = `# Prover.toml - Copy this to noir_circuit/Prover.toml\n`;
      toml += `root = "${deposit.root}"\n`;
      toml += `nullifier = "${deposit.nullifier}"\n`;
        toml += `recipient = "${recipientField}"\n`;
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
  }, [recipientAddress]);

  // Phase 0: Backend setup (run once per machine)
  const generateBackendSetupCommands = useCallback(() => {
    return `# Phase 0: Backend setup (run once)
# Noir
noirup -v 1.0.0-beta.13

# Sunspot (commit 5fd6223 for Noir compatibility)
git clone https://github.com/reilabs/sunspot.git ~/sunspot
cd ~/sunspot && git checkout 5fd6223
cd go && go build -o sunspot .
export PATH="$HOME/sunspot/go:$PATH"

# Repo (if not cloned)
git clone https://github.com/Ham3798/shielded-pool-pinocchio-solana.git
cd shielded-pool-pinocchio-solana`;
  }, []);

  // Phase 2–4: Circuit execution + client
  const generateCliCommands = useCallback(() => {
    return `# After Phase 0 and Phase 1 (copy 3 Prover.toml files)

# Phase 2-A: Compute ct_commitment (required for audit)
cd ct_helper
# Paste Prover.toml, then:
nargo check
nargo execute
# Output 0x... is ct_commitment - replace in audit_circuit/Prover.toml

# Phase 2-B: Withdraw proof
cd ../noir_circuit
# Paste Prover.toml, then:
nargo check
nargo execute
sunspot prove target/shielded_pool_verifier.json \\
  target/shielded_pool_verifier.gz \\
  target/shielded_pool_verifier.ccs \\
  target/shielded_pool_verifier.pk

# Phase 2-C: Audit proof (replace ct_commitment first)
cd ../audit_circuit
# Paste Prover.toml with ct_commitment from Phase 2-A output, then:
nargo check
nargo execute
sunspot prove target/rlwe_audit.json \\
  target/rlwe_audit.gz \\
  target/rlwe_audit.ccs \\
  target/rlwe_audit.pk

# Phase 3: Hex conversion
cd ../client
npx tsx generate-proof-hex.ts`;
  }, []);

  // ## SH START ##
  const copyWithFeedback = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }, []);

  // Helper to pack values for ct_helper and audit circuits
  const packCiphertextValues = useCallback((hexArr: string[]): string[] => {
    const PACK_WIDTH = 7;
    const PACK_BITS = 32n;
    const packed: string[] = [];
    for (let i = 0; i < hexArr.length; i += PACK_WIDTH) {
      let v = 0n;
      for (let j = 0; j < PACK_WIDTH && i + j < hexArr.length; j++) {
        const coeff = BigInt(hexArr[i + j]) % 167772161n;
        v += coeff << (BigInt(j) * PACK_BITS);
      }
      packed.push('"0x' + v.toString(16).padStart(64, "0") + '"');
    }
    return packed;
  }, []);

  const generateCtHelperToml = useCallback(
    (deposit: DepositRecord) => {
      if (!deposit.rlweCiphertext) return "# RLWE data not available for this deposit";

      const c0Packed = packCiphertextValues(deposit.rlweCiphertext.c0Sparse);
      const c1Packed = packCiphertextValues(deposit.rlweCiphertext.c1);

      return `# ct_helper Prover.toml - Run this first to compute ct_commitment
# Copy to ct_helper/Prover.toml, then run: nargo execute
c0_packed = [${c0Packed.join(", ")}]
c1_packed = [${c1Packed.join(", ")}]
`;
    },
    [packCiphertextValues]
  );

  const generateAuditToml = useCallback(
    (deposit: DepositRecord) => {
      if (!deposit.rlweCiphertext || !deposit.rlweNoise || !deposit.rlweQuotients) {
        return "# RLWE data not available for this deposit";
      }
      const c0Packed = packCiphertextValues(deposit.rlweCiphertext.c0Sparse).map(s => s.slice(1, -1)); // Remove outer quotes
      const c1Packed = packCiphertextValues(deposit.rlweCiphertext.c1).map(s => s.slice(1, -1));

      const q = (v: string) => `"${v}"`;
      const arr = (a: string[]) => `[${a.map(q).join(", ")}]`;
      let toml = `# Audit Prover.toml - Copy this to audit_circuit/Prover.toml\n`;
      toml += `# IMPORTANT: Replace ct_commitment with the value from ct_helper!\n`;
      toml += `secret_key = ${q(deposit.secretKey)}\n`;
      toml += `wa_commitment = ${q(deposit.waCommitment)}\n`;
      toml += `ct_commitment = "REPLACE_WITH_CT_HELPER_OUTPUT"\n`;
      toml += `c0_packed = ${arr(c0Packed)}\n`;
      toml += `c1_packed = ${arr(c1Packed)}\n`;
      toml += `r = ${arr(deposit.rlweNoise.r)}\n`;
      toml += `e1_sparse = ${arr(deposit.rlweNoise.e1Sparse)}\n`;
      toml += `e2 = ${arr(deposit.rlweNoise.e2)}\n`;
      toml += `k0 = ${arr(deposit.rlweQuotients.k0)}\n`;
      toml += `k1 = ${arr(deposit.rlweQuotients.k1)}\n`;
      return toml;
    },
    [packCiphertextValues]
  );

  const handleDecrypt = useCallback(async (deposit: DepositRecord) => {
    if (!deposit.rlweCiphertext) return;
    setIsDecrypting(true);
    setDecryptedIdentity(null);
    try {
      const c0Sparse = deposit.rlweCiphertext.c0Sparse.map((h) => BigInt(h));
      const c1 = deposit.rlweCiphertext.c1.map((h) => BigInt(h));
      const result = await decryptFromShares(c0Sparse, c1);
      setDecryptedIdentity(result);
    } catch (err) {
      console.error("Decrypt failed:", err);
    } finally {
      setIsDecrypting(false);
    }
  }, []);

  const handleAuditProofSubmit = useCallback(async () => {
    if (!walletAddress || !auditProofHex || !auditWitnessHex) {
      setStatusMessage(createStatus("error", "Missing audit proof or witness hex"));
      return;
    }
    try {
      setStatusMessage(createStatus("loading", "Submitting audit proof..."));
      if (!auditProofHex.startsWith("0x") || auditProofHex.length < 10) {
        throw new ShieldedPoolError(ErrorCode.PROOF_PARSE_ERROR);
      }
      if (!auditWitnessHex.startsWith("0x") || auditWitnessHex.length < 10) {
        throw new ShieldedPoolError(ErrorCode.WITNESS_PARSE_ERROR);
      }
      const proofBytes = hexToBytes(auditProofHex);
      const witnessBytes = hexToBytes(auditWitnessHex);
      const data = new Uint8Array(proofBytes.length + witnessBytes.length);
      data.set(proofBytes, 0);
      data.set(witnessBytes, proofBytes.length);

      const auditIx = {
        programAddress: AUDIT_VERIFIER_PROGRAM_ID,
        accounts: [] as { address: typeof walletAddress; role: number }[],
        data,
      };

      setStatusMessage(createStatus("loading", "Awaiting signature... (Audit ZK proof verification)"));
      const signature = await send({
        instructions: [
          getSetComputeUnitLimitInstruction({ units: 1_000_000 }),
          auditIx,
        ],
      });
      // Extract wa_commitment and ct_commitment from public witness (12-byte header + 2×32 bytes)
      const txSig = signature ?? "";
      let waCommitmentHex = "N/A";
      let ctCommitmentHex = "N/A";
      if (witnessBytes.length >= 76) {
        waCommitmentHex = "0x" + Array.from(witnessBytes.slice(12, 44)).map((b) => b.toString(16).padStart(2, "0")).join("");
        ctCommitmentHex = "0x" + Array.from(witnessBytes.slice(44, 76)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      const depForBjj = selectedDeposit || deposits.find((d) => d.status === "pending") || deposits[0];
      const logEntry = {
        nullifier: depForBjj?.nullifier ?? "",
        waCommitment: waCommitmentHex,
        ctCommitment: ctCommitmentHex,
        txSignature: txSig,
        timestamp: Date.now(),
        bjjX: depForBjj?.publicKeyX ?? "",
        bjjY: depForBjj?.publicKeyY ?? "",
      };
      setAuditLogs((prev) => [...prev, logEntry]);
      saveAuditLog(logEntry).catch(console.error);
      setStatusMessage(createStatus("success", `Audit proof verified on-chain! TX: ${txSig.slice(0, 20)}...`));
      setAuditProofHex("");
      setAuditWitnessHex("");
    } catch (err) {
      console.error("Audit proof submit failed:", err);
      const error = parseTransactionError(err);
      setStatusMessage(createErrorStatus(error));
    }
  }, [walletAddress, auditProofHex, auditWitnessHex, send, selectedDeposit]);
  // ## SH END ##

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
                  const isRecent = Date.now() - deposit.createdAt < 15000;
                  rootStatus = isRecent ? (
                    <span className="text-xs text-blue-600">Syncing...</span>
                  ) : (
                    <span className="text-xs text-red-600">Root expired</span>
                  );
                }
              } else {
                rootStatus = <span className="text-xs text-blue-600">Preparing...</span>;
              }
              return (
                <button
                  key={deposit.id}
                  onClick={() => {
                    setSelectedDeposit(isSelected ? null : deposit);
                    setShowCliInstructions(!isSelected);
                    setDecryptedIdentity(null); // ## SH ##
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
                      {/* ## SH START ## */}
                      <span className="ml-2 text-xs text-muted font-mono">
                        N: {deposit.nullifier.slice(0, 10)}...
                      </span>
                      {/* ## SH END ## */}
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
            disabled={isSending || isProcessing || !amount || parseFloat(amount) < 0.001 || !isPoseidonReady}
            className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isProcessing ? (isSending ? "Confirming TX..." : "Encrypting...") : "Deposit"}
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

          {/* Phase 0: Backend Setup (Once) - Collapsible */}
          <div className="rounded-lg border border-slate-500/40 bg-slate-900/20 overflow-hidden">
            <button
              type="button"
              onClick={() => setShowBackendSetup(!showBackendSetup)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-800/30 transition"
            >
              <span className="text-sm font-semibold text-slate-300">
                Phase 0: Backend setup (once, export included)
              </span>
              <span className="text-slate-500">{showBackendSetup ? "v" : ">"}</span>
            </button>
            {showBackendSetup && (
              <div className="border-t border-slate-600/50 p-4 space-y-2">
                <p className="text-xs text-slate-400">
                  Noir, Sunspot, PATH export. Run once per machine.
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={() => copyWithFeedback(generateBackendSetupCommands(), "backend-setup")}
                    className="rounded bg-slate-600 px-3 py-1 text-xs font-medium text-white hover:bg-slate-500"
                  >
                    {copiedKey === "backend-setup" ? "Copied!" : "Copy Backend Commands"}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs font-mono text-green-400">
                  {generateBackendSetupCommands()}
                </pre>
              </div>
            )}
          </div>

          {/* Root Status Warning */}
          {!onChainState && (
            <div className="rounded-lg bg-blue-100 border border-blue-200 px-4 py-3 text-sm text-blue-800">
              Preparing... Loading on-chain state.
            </div>
          )}

          {rootValidation && !rootValidation.isValid && selectedDeposit && (
            Date.now() - selectedDeposit.createdAt < 15000 ? (
              <div className="rounded-lg bg-blue-100 border border-blue-200 px-4 py-3 text-sm text-blue-800">
                Waiting for on-chain sync... Will update automatically.
              </div>
            ) : (
              <div className="rounded-lg bg-red-100 border border-red-200 px-4 py-3 text-sm text-red-800">
                <strong>Warning:</strong> This deposit&apos;s root has expired. You need to create a
                new deposit.
              </div>
            )
          )}

          {rootValidation && rootValidation.isValid && rootValidation.index !== null && onChainState && isRootNearExpiry(onChainState, rootValidation.index) && (
            <div className="rounded-lg bg-orange-100 border border-orange-200 px-4 py-3 text-sm text-orange-800">
              <strong>Warning:</strong> This root is near expiry. Generate and submit proof
              soon.
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs text-muted">Withdraw to (recipient):</label>
            <input
              type="text"
              placeholder="Solana address (must match proof recipient)"
              value={recipientAddress}
              onChange={(e) => setRecipientAddress(e.target.value)}
              disabled={isSending}
              className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 text-xs font-mono outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <p className="text-xs text-muted">
              Enter recipient before copying Prover.toml. Proof is bound to this address.
            </p>
          </div>

          {/* Phase 1: Prover.toml copy */}
          <div className="rounded-lg border border-amber-600/30 bg-amber-900/10 p-4 space-y-3">
            <h4 className="text-sm font-semibold text-amber-400">Phase 1: Copy Prover.toml</h4>
            <p className="text-xs text-gray-400">
              Copy each to the corresponding directory.
            </p>
            <div className="space-y-3">
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-amber-300">1-A. noir_circuit/Prover.toml</span>
                  <button
                    onClick={() => copyWithFeedback(generateProverToml(selectedDeposit), "pool-toml")}
                    className="rounded bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90"
                  >
                    {copiedKey === "pool-toml" ? "Copied!" : "Copy Pool"}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-card p-2 text-xs font-mono max-h-32">
                  {generateProverToml(selectedDeposit)}
                </pre>
              </div>
              {selectedDeposit.rlweCiphertext && (
                <>
                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-amber-300">1-B. ct_helper/Prover.toml</span>
                      <button
                        onClick={() => copyWithFeedback(generateCtHelperToml(selectedDeposit), "ct-helper-toml")}
                        className="rounded bg-yellow-600 px-3 py-1 text-xs font-medium text-white hover:bg-yellow-500"
                      >
                        {copiedKey === "ct-helper-toml" ? "Copied!" : "Copy ct_helper"}
                      </button>
                    </div>
                    <pre className="overflow-x-auto rounded-lg bg-card p-2 text-xs font-mono max-h-20">
                      {generateCtHelperToml(selectedDeposit)}
                    </pre>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-amber-300">1-C. audit_circuit/Prover.toml</span>
                      <button
                        onClick={() => copyWithFeedback(generateAuditToml(selectedDeposit), "audit-toml")}
                        className="rounded bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90"
                      >
                        {copiedKey === "audit-toml" ? "Copied!" : "Copy Audit"}
                      </button>
                    </div>
                    <div className="rounded bg-orange-900/20 border border-orange-600/30 px-2 py-1 text-xs text-orange-300">
                      Replace ct_commitment after Phase 2-A.
                    </div>
                    <pre className="overflow-x-auto rounded-lg bg-card p-2 text-xs font-mono max-h-24">
                      {generateAuditToml(selectedDeposit).slice(0, 500)}...
                    </pre>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Phase 2–3: Circuit execution + client */}
          <div className="rounded-lg border border-emerald-600/30 bg-emerald-900/10 p-4 space-y-3">
            <h4 className="text-sm font-semibold text-emerald-400">Phase 2–3: Circuit execution and client hex</h4>
            <div className="flex justify-end">
              <button
                onClick={() => copyWithFeedback(generateCliCommands(), "cli-cmds")}
                className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500"
              >
                {copiedKey === "cli-cmds" ? "Copied!" : "Copy All Commands"}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs font-mono text-green-400 whitespace-pre-wrap">
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

          {/* ## SH START ## */}
          {/* BJJ Identity Display */}
          <div className="rounded-lg border border-border-low bg-card p-3 space-y-2">
            <p className="text-xs font-medium">BabyJubJub Identity (BJJ Pubkey)</p>
            <div className="space-y-1">
              <p className="text-xs text-muted">owner_x:</p>
              <p className="font-mono text-xs break-all select-all">{selectedDeposit.publicKeyX}</p>
              <p className="text-xs text-muted mt-1">owner_y:</p>
              <p className="font-mono text-xs break-all select-all">{selectedDeposit.publicKeyY}</p>
            </div>
            <p className="text-xs text-muted">nullifier: <span className="font-mono">{selectedDeposit.nullifier.slice(0, 22)}...</span></p>
          </div>

          {/* Proof Generation Workflow Overview */}
          <div className="rounded-lg border border-blue-600/30 bg-blue-900/10 p-4 space-y-3">
            <h4 className="text-sm font-semibold text-blue-400">Execution order</h4>
            <ol className="text-xs text-gray-300 space-y-1 list-decimal list-inside">
              <li><strong>Phase 0</strong> – Backend setup (export, noirup, sunspot). Once.</li>
              <li><strong>Phase 1</strong> – Copy 3 Prover.toml (noir_circuit, ct_helper, audit_circuit)</li>
              <li><strong>Phase 2-A</strong> – ct_helper: nargo check, nargo execute to get ct_commitment</li>
              <li><strong>Phase 2-B</strong> – noir_circuit: nargo check, nargo execute + sunspot prove</li>
              <li><strong>Phase 2-C</strong> – audit_circuit: replace ct_commitment, nargo check, nargo execute + sunspot prove</li>
              <li><strong>Phase 3</strong> – client: npx tsx generate-proof-hex.ts</li>
            </ol>
          </div>

          {/* Shamir Decrypt */}
          {selectedDeposit.rlweCiphertext && (
            <div className="space-y-2 rounded-lg border border-border-low bg-card p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Decrypt Identity (Shamir 2-of-3)</p>
                <button
                  onClick={() => handleDecrypt(selectedDeposit)}
                  disabled={isDecrypting}
                  className="rounded bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90 disabled:opacity-40"
                >
                  {isDecrypting ? "Decrypting..." : "Decrypt"}
                </button>
              </div>
              {decryptedIdentity && (
                <div className="space-y-1 rounded-lg bg-cream/30 p-2">
                  <p className="text-xs text-muted">Recovered owner_x:</p>
                  <p className="font-mono text-xs break-all">0x{decryptedIdentity.ownerX.toString(16).padStart(64, "0")}</p>
                  <p className="text-xs text-muted mt-1">Recovered owner_y:</p>
                  <p className="font-mono text-xs break-all">0x{decryptedIdentity.ownerY.toString(16).padStart(64, "0")}</p>
                  <p className={`text-xs mt-1 font-medium ${
                    "0x" + decryptedIdentity.ownerX.toString(16).padStart(64, "0") === selectedDeposit.publicKeyX
                      ? "text-green-600" : "text-red-600"
                  }`}>
                    {("0x" + decryptedIdentity.ownerX.toString(16).padStart(64, "0")) === selectedDeposit.publicKeyX
                      ? "Match confirmed" : "Mismatch!"}
                  </p>
                </div>
              )}
            </div>
          )}
          {/* ## SH END ## */}
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
          <label className="text-xs text-muted">Audit Proof (hex):</label>
          <textarea
            placeholder="0x... (paste audit proof hex from CLI)"
            value={auditProofHex}
            onChange={(e) => setAuditProofHex(e.target.value)}
            disabled={isSending}
            rows={2}
            className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 text-xs font-mono outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs text-muted">Audit Public Witness (hex):</label>
          <textarea
            placeholder="0x... (paste audit witness hex from CLI)"
            value={auditWitnessHex}
            onChange={(e) => setAuditWitnessHex(e.target.value)}
            disabled={isSending}
            rows={2}
            className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 text-xs font-mono outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs text-muted">Recipient Address (must match Step 2):</label>
          <input
            type="text"
            placeholder="Same address used when generating proof"
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
            disabled={isSending}
            className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 text-xs font-mono outline-none transition placeholder:text-muted focus:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <button
          onClick={handleWithdraw}
          disabled={isSending || !proofHex || !witnessHex || !auditProofHex || !auditWitnessHex || !recipientAddress}
          className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSending ? "Verifying & Withdrawing..." : "Submit via Relayer"}
        </button>
        <p className="text-xs text-muted">
          Withdrawals are submitted via server relayer for privacy. Both ZK proof and audit proof are verified on-chain.
        </p>
        <p className="text-xs text-muted">
          <span className="text-red-600 font-medium">*</span> Relayer has no gas? Withdrawals will fail. Fund the address below to keep the service running.
        </p>
        {relayerStatus && (
          <div className={`rounded-xl border p-4 ${relayerStatus.lowBalance ? "border-orange-300 bg-orange-50 dark:bg-orange-950/20" : "border-border-low bg-cream/30"}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted">Relayer</p>
                <p className="mt-1 font-mono text-sm truncate max-w-[240px]" title={relayerStatus.relayerAddress}>
                  {relayerStatus.relayerAddress}
                </p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {relayerStatus.balanceSol.toFixed(4)}{" "}
                  <span className="text-sm font-normal text-muted">SOL</span>
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  onClick={() => copyWithFeedback(relayerStatus.relayerAddress, "relayer-addr")}
                  className="rounded bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90"
                >
                  {copiedKey === "relayer-addr" ? "Copied" : "Copy address"}
                </button>
                {relayerStatus.lowBalance && (
                  <span className="text-xs font-medium text-orange-700 dark:text-orange-400">
                    Low balance. Fund to enable withdrawals.
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
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
                  <th className="pb-2 text-left font-medium text-muted">Nullifier</th>
                  <th className="pb-2 text-left font-medium text-muted">Date</th>
                </tr>
              </thead>
              <tbody>
                {deposits
                  .filter((d) => d.status === "withdrawn")
                  .map((deposit) => (
                    <tr
                      key={deposit.id}
                      className={`border-b border-border-low/50 transition-colors ${hoveredNullifier === deposit.nullifier ? "bg-blue-50" : ""}`}
                      onMouseEnter={() => setHoveredNullifier(deposit.nullifier)}
                      onMouseLeave={() => setHoveredNullifier(null)}
                    >
                      <td className="py-2 font-mono">
                        {(Number(deposit.amount) / 1e9).toFixed(4)} SOL
                      </td>
                      <td className="py-2 font-mono text-muted">
                        {deposit.nullifier.slice(0, 22)}...
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

      {/* Audit History — one row per withdrawn deposit */}
      {deposits.filter((d) => d.status === "withdrawn").length > 0 && (
        <div className="space-y-2 border-t border-border-low pt-4">
          <p className="text-sm font-medium">Audit History</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-low">
                  <th className="pb-2 text-left font-medium text-muted">Nullifier</th>
                  <th className="pb-2 text-left font-medium text-muted">Audit Status</th>
                  <th className="pb-2 text-left font-medium text-muted">TX</th>
                  <th className="pb-2 text-left font-medium text-muted">Date</th>
                  <th className="pb-2 text-left font-medium text-muted">BJJ Address</th>
                </tr>
              </thead>
              <tbody>
                {deposits
                  .filter((d) => d.status === "withdrawn")
                  .map((deposit) => {
                    const auditLog = auditLogs.find((l) => l.nullifier === deposit.nullifier);
                    return (
                      <tr
                        key={deposit.id}
                        className={`border-b border-border-low/50 transition-colors ${hoveredNullifier === deposit.nullifier ? "bg-blue-50" : ""}`}
                        onMouseEnter={() => setHoveredNullifier(deposit.nullifier)}
                        onMouseLeave={() => setHoveredNullifier(null)}
                      >
                        <td className="py-2 font-mono text-muted">
                          {deposit.nullifier.slice(0, 22)}...
                        </td>
                        <td className="py-2">
                          {auditLog ? (
                            <span className="text-xs text-green-600">Verified</span>
                          ) : (
                            <span className="text-xs text-orange-600">Pending</span>
                          )}
                        </td>
                        <td className="py-2 font-mono text-muted">
                          {auditLog ? auditLog.txSignature.slice(0, 14) + "..." : "-"}
                        </td>
                        <td className="py-2 text-muted">
                          {new Date(deposit.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-2">
                          <button
                            className="text-xs text-blue-600 hover:underline"
                            onClick={() => {
                              alert(
                                `BJJ Owner Address\n\nX: ${deposit.publicKeyX}\nY: ${deposit.publicKeyY}`
                              );
                            }}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
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

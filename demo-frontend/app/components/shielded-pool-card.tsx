"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  useWalletConnection,
  useSendTransaction,
  useBalance,
} from "@solana/react-hooks";
import { getProgramDerivedAddress, type Address } from "@solana/kit";
import {
  initPoseidon,
  randomField128,
  randomField,
  calculateWaCommitment,
  calculateCommitment,
  calculateNullifier,
  ShieldedPoolMerkleTree,
  fieldToHex,
  fieldToBytes,
  u64ToLeBytes,
  type IdentityKeypair,
} from "../lib/merkle";
import {
  SHIELDED_POOL_PROGRAM_ID,
  ZK_VERIFIER_PROGRAM_ID,
  SYSTEM_PROGRAM_ADDRESS,
  INSTRUCTION,
  LAMPORTS_PER_SOL,
  recipientFieldFromPubkey,
  type AuditLogEntry,
} from "../lib/shielded-pool";

// Helper function to convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Interface for deposit data needed for CLI proof generation
interface DepositData {
  root: string;
  nullifier: string;
  recipient: string;
  amount: bigint;
  waCommitment: string;
  secretKey: string;
  ownerX: string;
  ownerY: string;
  randomness: string;
  index: number;
  siblings: string[];
}

export function ShieldedPoolCard() {
  const { wallet, status } = useWalletConnection();
  const { send, isSending } = useSendTransaction();

  const [amount, setAmount] = useState("");
  const [vaultAddress, setVaultAddress] = useState<Address | null>(null);
  const [stateAddress, setStateAddress] = useState<Address | null>(null);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [isPoseidonReady, setIsPoseidonReady] = useState(false);
  const merkleTreeRef = useRef<ShieldedPoolMerkleTree | null>(null);

  // Deposit data for CLI proof generation
  const [depositData, setDepositData] = useState<DepositData | null>(null);
  const [showCliInstructions, setShowCliInstructions] = useState(false);

  // Withdraw form state
  const [proofHex, setProofHex] = useState("");
  const [witnessHex, setWitnessHex] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");

  // Get or create merkle tree (only after Poseidon is ready)
  const getMerkleTree = useCallback(() => {
    if (!merkleTreeRef.current && isPoseidonReady) {
      merkleTreeRef.current = new ShieldedPoolMerkleTree();
    }
    return merkleTreeRef.current;
  }, [isPoseidonReady]);

  const walletAddress = wallet?.account.address;

  // Initialize Poseidon
  useEffect(() => {
    initPoseidon().then(() => setIsPoseidonReady(true));
  }, []);

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

  // Get vault balance
  const vaultBalance = useBalance(vaultAddress ?? undefined);
  const vaultLamports = vaultBalance?.lamports ?? 0n;
  const vaultSol = Number(vaultLamports) / Number(LAMPORTS_PER_SOL);

  const handleDeposit = useCallback(async () => {
    if (!walletAddress || !vaultAddress || !stateAddress || !amount || !isPoseidonReady) return;

    const merkleTree = getMerkleTree();
    if (!merkleTree) return;

    try {
      setTxStatus("Generating BabyJubJub identity...");

      // Generate identity (128-bit secret key for Noir compatibility)
      const secretKey = randomField128();
      const identity: IdentityKeypair = {
        secretKey,
        publicKey: { x: secretKey, y: secretKey }, // Simplified - in production use proper curve multiplication
      };
      const randomness = randomField();
      const depositAmount = BigInt(Math.floor(parseFloat(amount) * Number(LAMPORTS_PER_SOL)));

      // Calculate cryptographic values
      const waCommitment = calculateWaCommitment(identity.publicKey);
      const commitment = calculateCommitment(identity.publicKey, depositAmount, randomness);
      const index = merkleTree.insert(commitment);
      const root = merkleTree.getRoot();
      const nullifier = calculateNullifier(identity.secretKey, BigInt(index));
      const siblings = merkleTree.getProof(index);

      setTxStatus("Building deposit transaction...");

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

      setTxStatus("Awaiting signature...");

      const signature = await send({ instructions: [instruction] });

      // Store deposit data for CLI proof generation
      const recipientField = recipientFieldFromPubkey(walletAddress);
      const newDepositData: DepositData = {
        root: fieldToHex(root),
        nullifier: fieldToHex(nullifier),
        recipient: recipientField,
        amount: depositAmount,
        waCommitment: fieldToHex(waCommitment),
        secretKey: fieldToHex(identity.secretKey),
        ownerX: fieldToHex(identity.publicKey.x),
        ownerY: fieldToHex(identity.publicKey.y),
        randomness: fieldToHex(randomness),
        index,
        siblings: siblings.map(fieldToHex),
      };
      setDepositData(newDepositData);
      setShowCliInstructions(true);

      // Add to audit log
      const logEntry: AuditLogEntry = {
        name: `Deposit #${auditLog.length + 1}`,
        amount: depositAmount,
        waCommitment: fieldToHex(waCommitment).slice(0, 22) + "...",
        nullifier: fieldToHex(nullifier).slice(0, 22) + "...",
        recipient: walletAddress,
        txSignature: signature?.slice(0, 20) + "...",
      };
      setAuditLog((prev) => [...prev, logEntry]);

      setTxStatus(`Deposited! TX: ${signature?.slice(0, 20)}... - See CLI instructions below`);
      setAmount("");
    } catch (err) {
      console.error("Deposit failed:", err);
      setTxStatus(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }, [walletAddress, vaultAddress, stateAddress, amount, isPoseidonReady, send, getMerkleTree, auditLog.length]);

  const handleWithdraw = useCallback(async () => {
    if (!walletAddress || !vaultAddress || !stateAddress || !proofHex || !witnessHex || !recipientAddress) {
      setTxStatus("Please fill in all withdraw fields (proof, witness, recipient)");
      return;
    }

    try {
      setTxStatus("Parsing proof data...");

      // Convert hex to bytes
      const proofBytes = hexToBytes(proofHex);
      const witnessBytes = hexToBytes(witnessHex);

      // Extract nullifier from witness (12 byte header + first 32 bytes after header is root, next 32 is nullifier)
      const WITNESS_HEADER_LEN = 12;
      const nullifierBytes = witnessBytes.slice(WITNESS_HEADER_LEN + 32, WITNESS_HEADER_LEN + 64);

      // Derive nullifier PDA
      const [nullifierPda] = await getProgramDerivedAddress({
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        seeds: [new TextEncoder().encode("nullifier"), nullifierBytes],
      });

      setTxStatus("Building withdraw transaction...");

      // Build withdraw instruction data: [WITHDRAW, proof, witness]
      const data = new Uint8Array(1 + proofBytes.length + witnessBytes.length);
      data[0] = INSTRUCTION.WITHDRAW;
      data.set(proofBytes, 1);
      data.set(witnessBytes, 1 + proofBytes.length);

      const withdrawIx = {
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        accounts: [
          { address: walletAddress, role: 3 },  // fee payer
          { address: recipientAddress as Address, role: 1 },  // recipient
          { address: vaultAddress, role: 1 },  // vault
          { address: stateAddress, role: 1 },  // state
          { address: nullifierPda, role: 1 },  // nullifier
          { address: ZK_VERIFIER_PROGRAM_ID, role: 0 },  // verifier
          { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },  // system
        ],
        data,
      };

      setTxStatus("Awaiting signature... (ZK proof verification on-chain)");

      const signature = await send({ 
        instructions: [withdrawIx],
      });

      setTxStatus(`Withdraw successful! TX: ${signature?.slice(0, 20)}...`);
      setProofHex("");
      setWitnessHex("");
      setDepositData(null);
      setShowCliInstructions(false);
    } catch (err) {
      console.error("Withdraw failed:", err);
      setTxStatus(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }, [walletAddress, vaultAddress, stateAddress, proofHex, witnessHex, recipientAddress, send]);

  // Generate Prover.toml content
  const generateProverToml = useCallback(() => {
    if (!depositData) return "";
    
    let toml = `# Prover.toml - Copy this to noir_circuit/Prover.toml\n`;
    toml += `root = "${depositData.root}"\n`;
    toml += `nullifier = "${depositData.nullifier}"\n`;
    toml += `recipient = "${depositData.recipient}"\n`;
    toml += `amount = ${depositData.amount}\n`;
    toml += `wa_commitment = "${depositData.waCommitment}"\n`;
    toml += `secret_key = "${depositData.secretKey}"\n`;
    toml += `owner_x = "${depositData.ownerX}"\n`;
    toml += `owner_y = "${depositData.ownerY}"\n`;
    toml += `randomness = "${depositData.randomness}"\n`;
    toml += `index = ${depositData.index}\n`;
    toml += `siblings = [\n`;
    for (const sib of depositData.siblings) {
      toml += `  "${sib}",\n`;
    }
    toml += `]\n`;
    return toml;
  }, [depositData]);

  if (status !== "connected") {
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
        <span className="rounded-full bg-cream px-3 py-1 text-xs font-semibold uppercase tracking-wide text-foreground/80">
          {isPoseidonReady ? "Ready" : "Loading..."}
        </span>
      </div>

      {/* Pool Balance */}
      <div className="rounded-xl border border-border-low bg-cream/30 p-4">
        <p className="text-xs uppercase tracking-wide text-muted">Pool Balance</p>
        <p className="mt-1 text-3xl font-bold tabular-nums">
          {vaultSol.toFixed(4)}{" "}
          <span className="text-lg font-normal text-muted">SOL</span>
        </p>
        {vaultAddress && (
          <p className="mt-2 truncate font-mono text-xs text-muted">
            Vault: {vaultAddress}
          </p>
        )}
      </div>

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
          Deposits create a ZK commitment. After deposit, follow CLI instructions to generate proof.
        </p>
      </div>

      {/* CLI Instructions (shown after deposit) */}
      {showCliInstructions && depositData && (
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
          
          <div className="space-y-2">
            <p className="text-xs text-muted">1. Copy Prover.toml content:</p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-lg bg-card p-3 text-xs font-mono max-h-48">
                {generateProverToml()}
              </pre>
              <button
                onClick={() => navigator.clipboard.writeText(generateProverToml())}
                className="absolute right-2 top-2 rounded bg-cream px-2 py-1 text-xs font-medium hover:bg-cream/70"
              >
                Copy
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted">2. Run commands in terminal:</p>
            <pre className="overflow-x-auto rounded-lg bg-card p-3 text-xs font-mono">
{`cd noir_circuit
nargo execute
sunspot prove target/shielded_pool_verifier.json \\
  target/shielded_pool_verifier.gz \\
  target/shielded_pool_verifier.ccs \\
  target/shielded_pool_verifier.pk`}
            </pre>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted">3. Convert proof files to hex (run from project root):</p>
            <pre className="overflow-x-auto rounded-lg bg-card p-3 text-xs font-mono">
{`cd client
npx tsx generate-proof-hex.ts`}
            </pre>
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

      {/* Status */}
      {txStatus && (
        <div className="rounded-lg border border-border-low bg-cream/50 px-4 py-3 text-sm">
          {txStatus}
        </div>
      )}

      {/* Audit Log */}
      {auditLog.length > 0 && (
        <div className="space-y-2 border-t border-border-low pt-4">
          <p className="text-sm font-medium">Audit Log (wa_commitments)</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-low">
                  <th className="pb-2 text-left font-medium text-muted">Name</th>
                  <th className="pb-2 text-right font-medium text-muted">Amount</th>
                  <th className="pb-2 text-left font-medium text-muted">wa_commitment</th>
                </tr>
              </thead>
              <tbody>
                {auditLog.map((entry, i) => (
                  <tr key={i} className="border-b border-border-low/50">
                    <td className="py-2">{entry.name}</td>
                    <td className="py-2 text-right font-mono">
                      {(Number(entry.amount) / 1e9).toFixed(4)} SOL
                    </td>
                    <td className="py-2 font-mono text-muted">{entry.waCommitment}</td>
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
          This is a{" "}
          <span className="font-semibold">ZK-proof based privacy pool</span> with BabyJubJub
          auditable identity, built for the Solana ecosystem.
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
          <span className="rounded-md bg-cream/50 px-2 py-1 font-mono">
            Poseidon Hash
          </span>
        </div>
      </div>
    </section>
  );
}

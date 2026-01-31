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
  SYSTEM_PROGRAM_ADDRESS,
  INSTRUCTION,
  LAMPORTS_PER_SOL,
  type AuditLogEntry,
} from "../lib/shielded-pool";

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
  
  // Get or create merkle tree (only after Poseidon is ready)
  const getMerkleTree = useCallback(() => {
    if (!merkleTreeRef.current && isPoseidonReady) {
      merkleTreeRef.current = new ShieldedPoolMerkleTree();
    }
    return merkleTreeRef.current;
  }, [isPoseidonReady]);

  // Current deposit state
  const [currentIdentity, setCurrentIdentity] = useState<IdentityKeypair | null>(null);
  const [currentRandomness, setCurrentRandomness] = useState<bigint | null>(null);
  const [currentCommitment, setCurrentCommitment] = useState<bigint | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);

  const walletAddress = wallet?.account.address;

  // Initialize Poseidon
  useEffect(() => {
    initPoseidon().then(() => setIsPoseidonReady(true));
  }, []);

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

      // Generate identity
      const secretKey = randomField128();
      const identity: IdentityKeypair = {
        secretKey,
        publicKey: { x: secretKey, y: secretKey }, // Simplified for demo
      };
      const randomness = randomField();
      const depositAmount = BigInt(Math.floor(parseFloat(amount) * Number(LAMPORTS_PER_SOL)));

      // Calculate commitment
      const waCommitment = calculateWaCommitment(identity.publicKey);
      const commitment = calculateCommitment(identity.publicKey, depositAmount, randomness);
      const index = merkleTree.insert(commitment);
      const root = merkleTree.getRoot();

      setCurrentIdentity(identity);
      setCurrentRandomness(randomness);
      setCurrentCommitment(commitment);
      setCurrentIndex(index);

      setTxStatus("Building deposit transaction...");

      // Build deposit data
      const depositData = new Uint8Array(1 + 8 + 32 + 32);
      depositData[0] = INSTRUCTION.DEPOSIT;
      depositData.set(u64ToLeBytes(depositAmount), 1);
      depositData.set(fieldToBytes(commitment), 1 + 8);
      depositData.set(fieldToBytes(root), 1 + 8 + 32);

      const instruction = {
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        accounts: [
          { address: walletAddress, role: 3 },
          { address: stateAddress, role: 1 },
          { address: vaultAddress, role: 1 },
          { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
        ],
        data: depositData,
      };

      setTxStatus("Awaiting signature...");

      const signature = await send({ instructions: [instruction] });

      // Add to audit log
      const logEntry: AuditLogEntry = {
        name: `Deposit #${auditLog.length + 1}`,
        amount: depositAmount,
        waCommitment: fieldToHex(waCommitment).slice(0, 22) + "...",
        nullifier: "Pending withdrawal",
        recipient: walletAddress,
        txSignature: signature?.slice(0, 20) + "...",
      };
      setAuditLog((prev) => [...prev, logEntry]);

      setTxStatus(`Deposited! TX: ${signature?.slice(0, 20)}...`);
      setAmount("");
    } catch (err) {
      console.error("Deposit failed:", err);
      setTxStatus(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }, [walletAddress, vaultAddress, stateAddress, amount, isPoseidonReady, send, getMerkleTree, auditLog.length]);

  const handleWithdraw = useCallback(async () => {
    if (!walletAddress || !currentIdentity || currentIndex === null) {
      setTxStatus("No active deposit to withdraw. Please deposit first.");
      return;
    }

    setTxStatus("ZK Proof generation requires backend API (not implemented in frontend demo)");
  }, [walletAddress, currentIdentity, currentIndex]);

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
        <p className="text-sm font-medium">Deposit SOL</p>
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
          Deposits create a ZK commitment with your BabyJubJub identity.
        </p>
      </div>

      {/* Withdraw Button */}
      <button
        onClick={handleWithdraw}
        disabled={isSending || !currentIdentity}
        className="w-full rounded-lg border border-border-low bg-card px-4 py-2.5 text-sm font-medium transition hover:-translate-y-0.5 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isSending ? "Processing..." : "Withdraw (Requires Backend API)"}
      </button>

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

/**
 * Solana Shielded Pool Payroll Demo
 *
 * E2E scenario demonstrating private payroll distribution:
 * 1. BOB deposits 3 commitments (300, 400, 300 lamports)
 * 2. Generate 3 ZK proofs in parallel (off-chain)
 * 3. Batch withdraw to ALICE, CHARLIE, DAVID in a single TX
 * 4. Print audit summary (wa_commitments)
 *
 * Usage:
 * cd client
 * ZK_VERIFIER_PROGRAM_ID=<verifier> SHIELDED_POOL_PROGRAM_ID=<pool> npx tsx payroll-demo.ts
 */

import {
    address,
    createKeyPairSignerFromBytes,
    generateKeyPairSigner,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    appendTransactionMessageInstructions,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    addSignersToTransactionMessage,
    assertIsSendableTransaction,
    assertIsTransactionWithBlockhashLifetime,
    sendAndConfirmTransactionFactory,
    getSignatureFromTransaction,
    getProgramDerivedAddress,
    getAddressEncoder,
    type Address,
    type KeyPairSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
    initPoseidon,
    poseidonHash2,
    generateIdentityKeypair,
    calculateWaCommitment,
    calculateCommitment,
    calculateNullifier,
    ShieldedPoolMerkleTree,
    type IdentityKeypair,
} from "./merkle.js";
import { generateProof, type CircuitConfig } from "./proof.helper.js";

// ============================================
// Configuration
// ============================================

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

const ZK_VERIFIER_PROGRAM_ID = address(requireEnv("ZK_VERIFIER_PROGRAM_ID"));
const SHIELDED_POOL_PROGRAM_ID = address(requireEnv("SHIELDED_POOL_PROGRAM_ID"));

const repoRoot = path.join(process.cwd(), "..");
const circuitConfig: CircuitConfig = {
    circuitDir: path.join(repoRoot, "noir_circuit"),
    circuitName: "shielded_pool_verifier",
};

const keypairDir = path.join(repoRoot, "keypair");
const senderWalletPath = path.join(keypairDir, "sender.json");
const relayerWalletPath = path.join(keypairDir, "relayer.json");

const INSTRUCTION = {
    INITIALIZE: 0,
    DEPOSIT: 1,
    WITHDRAW: 2,
};

// Payroll amounts (in lamports)
// Note: Must be >= rent-exempt minimum (~890,880 lamports) for new accounts
const ALICE_AMOUNT = 1_000_000n;   // 0.001 SOL (300 USDC equivalent for demo)
const CHARLIE_AMOUNT = 1_500_000n; // 0.0015 SOL (400 USDC equivalent for demo)
const DAVID_AMOUNT = 1_000_000n;   // 0.001 SOL (300 USDC equivalent for demo)

// ============================================
// Helper Functions
// ============================================

async function loadKeypair(filePath: string): Promise<KeyPairSigner> {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Keypair not found: ${filePath}`);
    }
    const bytes = new Uint8Array(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    return createKeyPairSignerFromBytes(bytes);
}

function fieldToHex(f: bigint): string {
    return "0x" + f.toString(16).padStart(64, "0");
}

function fieldToBytes(f: bigint): Uint8Array {
    const hex = f.toString(16).padStart(64, "0");
    return Uint8Array.from(Buffer.from(hex, "hex"));
}

function u64ToLeBytes(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    let v = value;
    for (let i = 0; i < 8; i += 1) {
        bytes[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return bytes;
}

function recipientFieldFromPubkey(pubkey: Address): string {
    const pubkeyBytes = getAddressEncoder().encode(pubkey);
    const trimmed = pubkeyBytes.slice(0, 30);
    const padded = Buffer.concat([Buffer.from([0, 0]), Buffer.from(trimmed)]);
    return "0x" + padded.toString("hex");
}

function randomField128(): bigint {
    const bytes = crypto.randomBytes(16);
    return BigInt("0x" + bytes.toString("hex"));
}

function randomField(): bigint {
    const bytes = crypto.randomBytes(31);
    return BigInt("0x" + bytes.toString("hex"));
}

type InstructionAccount = { address: Address; role: number };
type Instruction = {
    programAddress: Address;
    accounts: InstructionAccount[];
    data: Uint8Array;
};

async function sendTransaction(
    sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
    rpc: ReturnType<typeof createSolanaRpc>,
    feePayer: KeyPairSigner,
    signers: KeyPairSigner[],
    instructions: Instruction[],
    units: number,
    label: string
): Promise<string> {
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const baseMessage = createTransactionMessage({ version: 0 });
    const messageWithPayer = setTransactionMessageFeePayerSigner(feePayer, baseMessage);
    const messageWithLifetime = setTransactionMessageLifetimeUsingBlockhash(
        blockhash,
        messageWithPayer
    );
    const transactionMessage = appendTransactionMessageInstructions(
        [getSetComputeUnitLimitInstruction({ units }), ...instructions],
        messageWithLifetime
    );
    const messageWithSigners = addSignersToTransactionMessage(signers, transactionMessage);
    const signedTx = await signTransactionMessageWithSigners(messageWithSigners);
    assertIsSendableTransaction(signedTx);
    assertIsTransactionWithBlockhashLifetime(signedTx);
    const sig = await sendAndConfirm(signedTx, { commitment: "confirmed" });
    const sigText = sig ?? getSignatureFromTransaction(signedTx);
    console.log(`  ${label}: https://explorer.solana.com/tx/${sigText}?cluster=devnet`);
    return sigText;
}

// ============================================
// Data Structures for Payroll
// ============================================

interface PayrollEntry {
    name: string;
    amount: bigint;
    recipient: KeyPairSigner;
    identity: IdentityKeypair;
    randomness: bigint;
    commitment: bigint;
    index: number;
    waCommitment: bigint;
    nullifier: bigint;
}

// ============================================
// Main Demo
// ============================================

async function main() {
    const startTime = Date.now();
    
    console.log("=".repeat(70));
    console.log("  Solana Shielded Pool - Payroll Demo");
    console.log("=".repeat(70));
    console.log(`Network: Devnet`);
    console.log(`Pool Program: ${SHIELDED_POOL_PROGRAM_ID}`);
    console.log(`Verifier Program: ${ZK_VERIFIER_PROGRAM_ID}`);
    console.log("");

    // Initialize Poseidon
    await initPoseidon();

    // Setup RPC
    const rpc = createSolanaRpc(RPC_URL);
    const rpcSubscriptions = createSolanaRpcSubscriptions(
        RPC_URL.replace("https://", "wss://").replace("http://", "ws://")
    );
    const sendAndConfirm = sendAndConfirmTransactionFactory({
        rpc,
        rpcSubscriptions,
    });

    // Load wallets
    const sender = await loadKeypair(senderWalletPath);
    const relayer = await loadKeypair(relayerWalletPath);
    console.log(`Sender (BOB): ${sender.address}`);
    console.log(`Relayer: ${relayer.address}`);

    // Generate recipient keypairs
    const alice = await generateKeyPairSigner();
    const charlie = await generateKeyPairSigner();
    const david = await generateKeyPairSigner();

    console.log(`\nRecipients:`);
    console.log(`  ALICE:   ${alice.address}`);
    console.log(`  CHARLIE: ${charlie.address}`);
    console.log(`  DAVID:   ${david.address}`);

    // Derive PDAs
    const [statePda] = await getProgramDerivedAddress({
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        seeds: [new TextEncoder().encode("pool_state")],
    });
    const [vaultPda] = await getProgramDerivedAddress({
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        seeds: [new TextEncoder().encode("vault")],
    });

    // Initialize Merkle Tree
    const mt = new ShieldedPoolMerkleTree();

    // Create payroll entries
    const payrollEntries: PayrollEntry[] = [
        { name: "ALICE", amount: ALICE_AMOUNT, recipient: alice, identity: null!, randomness: 0n, commitment: 0n, index: 0, waCommitment: 0n, nullifier: 0n },
        { name: "CHARLIE", amount: CHARLIE_AMOUNT, recipient: charlie, identity: null!, randomness: 0n, commitment: 0n, index: 0, waCommitment: 0n, nullifier: 0n },
        { name: "DAVID", amount: DAVID_AMOUNT, recipient: david, identity: null!, randomness: 0n, commitment: 0n, index: 0, waCommitment: 0n, nullifier: 0n },
    ];

    // Generate identities and commitments
    console.log("\n" + "-".repeat(70));
    console.log("[Step 1] Generating BabyJubJub identities and commitments...");
    console.log("-".repeat(70));

    for (const entry of payrollEntries) {
        const secretKey = randomField128();
        entry.identity = generateIdentityKeypair(secretKey);
        entry.randomness = randomField();
        entry.waCommitment = calculateWaCommitment(entry.identity.publicKey);
        entry.commitment = calculateCommitment(entry.identity.publicKey, entry.amount, entry.randomness);
        entry.index = mt.insert(entry.commitment);
        entry.nullifier = calculateNullifier(entry.identity.secretKey, BigInt(entry.index));

        console.log(`  ${entry.name}:`);
        console.log(`    Amount: ${entry.amount} lamports`);
        console.log(`    wa_commitment: ${fieldToHex(entry.waCommitment).slice(0, 20)}...`);
    }

    // ============================================
    // Phase 1: Deposit 3 commitments
    // ============================================
    console.log("\n" + "-".repeat(70));
    console.log("[Step 2] Depositing 3 commitments to the pool...");
    console.log("-".repeat(70));

    for (const entry of payrollEntries) {
        const root = mt.getRoot();
        
        const depositData = new Uint8Array(1 + 8 + 32 + 32);
        depositData[0] = INSTRUCTION.DEPOSIT;
        depositData.set(u64ToLeBytes(entry.amount), 1);
        depositData.set(fieldToBytes(entry.commitment), 1 + 8);
        depositData.set(fieldToBytes(root), 1 + 8 + 32);

        const depositIx: Instruction = {
            programAddress: SHIELDED_POOL_PROGRAM_ID,
            accounts: [
                { address: sender.address, role: 3 },
                { address: statePda, role: 1 },
                { address: vaultPda, role: 1 },
                { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
            ],
            data: depositData,
        };

        await sendTransaction(
            sendAndConfirm,
            rpc,
            relayer,
            [sender],
            [depositIx],
            200_000,
            `Deposit ${entry.amount} lamports for ${entry.name}`
        );
    }

    // ============================================
    // Phase 2: Generate ZK proofs in parallel
    // ============================================
    console.log("\n" + "-".repeat(70));
    console.log("[Step 3] Generating ZK proofs in parallel...");
    console.log("-".repeat(70));

    const root = mt.getRoot();
    const proofStartTime = Date.now();

    const proofPromises = payrollEntries.map(async (entry) => {
        const entryStartTime = Date.now();
        const recipientField = recipientFieldFromPubkey(entry.recipient.address);

        const proofResult = generateProof(circuitConfig, {
            root: fieldToHex(root),
            nullifier: fieldToHex(entry.nullifier),
            recipient: recipientField,
            amount: Number(entry.amount),
            wa_commitment: fieldToHex(entry.waCommitment),
            secret_key: fieldToHex(entry.identity.secretKey),
            owner_x: fieldToHex(entry.identity.publicKey.x),
            owner_y: fieldToHex(entry.identity.publicKey.y),
            randomness: fieldToHex(entry.randomness),
            index: entry.index,
            siblings: mt.getProof(entry.index).map(fieldToHex),
        });

        const elapsed = ((Date.now() - entryStartTime) / 1000).toFixed(1);
        console.log(`  ${entry.name} proof generated (${elapsed}s)`);
        
        return { entry, proofResult };
    });

    const proofResults = await Promise.all(proofPromises);
    const totalProofTime = ((Date.now() - proofStartTime) / 1000).toFixed(1);
    console.log(`  Total proof generation time: ${totalProofTime}s`);

    // ============================================
    // Phase 3: Withdraw to each recipient
    // Note: Solana TX size limit (1232 bytes) prevents batching 3 withdrawals
    //       Each ZK proof is ~560 bytes, so we send separate TXs
    // ============================================
    console.log("\n" + "-".repeat(70));
    console.log("[Step 4] Withdrawing to recipients...");
    console.log("-".repeat(70));

    for (const { entry, proofResult } of proofResults) {
        const nullifierBytes = Buffer.from(entry.nullifier.toString(16).padStart(64, '0'), 'hex');
        const [nullifierPda] = await getProgramDerivedAddress({
            programAddress: SHIELDED_POOL_PROGRAM_ID,
            seeds: [new TextEncoder().encode("nullifier"), nullifierBytes],
        });

        const data = new Uint8Array(1 + proofResult.proof.length + proofResult.publicWitness.length);
        data[0] = INSTRUCTION.WITHDRAW;
        data.set(proofResult.proof, 1);
        data.set(proofResult.publicWitness, 1 + proofResult.proof.length);

        const withdrawIx: Instruction = {
            programAddress: SHIELDED_POOL_PROGRAM_ID,
            accounts: [
                { address: relayer.address, role: 3 },
                { address: entry.recipient.address, role: 1 },
                { address: vaultPda, role: 1 },
                { address: statePda, role: 1 },
                { address: nullifierPda, role: 1 },
                { address: ZK_VERIFIER_PROGRAM_ID, role: 0 },
                { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
            ],
            data,
        };

        await sendTransaction(
            sendAndConfirm,
            rpc,
            relayer,
            [],
            [withdrawIx],
            600_000,
            `Withdraw ${entry.amount} lamports to ${entry.name}`
        );
    }

    // ============================================
    // Phase 4: Verify balances and print audit summary
    // ============================================
    console.log("\n" + "-".repeat(70));
    console.log("[Step 5] Verifying recipient balances...");
    console.log("-".repeat(70));

    for (const entry of payrollEntries) {
        const balance = await rpc.getBalance(entry.recipient.address).send();
        console.log(`  ${entry.name}: ${balance.value} lamports`);
    }

    // ============================================
    // Audit Summary
    // ============================================
    console.log("\n" + "=".repeat(70));
    console.log("  AUDIT SUMMARY (wa_commitments for future RLWE audit)");
    console.log("=".repeat(70));

    for (const entry of payrollEntries) {
        console.log(`  ${entry.name.padEnd(10)} | Amount: ${entry.amount.toString().padStart(10)} | wa_commitment: ${fieldToHex(entry.waCommitment).slice(0, 22)}...`);
    }

    console.log("\nNullifiers (spent):");
    for (const entry of payrollEntries) {
        console.log(`  ${entry.name.padEnd(10)} | ${fieldToHex(entry.nullifier).slice(0, 22)}...`);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("\n" + "=".repeat(70));
    console.log(`  Demo completed in ${totalTime}s`);
    console.log("=".repeat(70));
}

main().catch((err) => {
    console.error("Demo failed:", err);
    process.exit(1);
});

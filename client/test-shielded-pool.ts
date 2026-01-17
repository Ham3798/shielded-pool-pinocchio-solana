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
    pipe,
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
    poseidonHash3,
    ShieldedPoolMerkleTree,
} from "./merkle.js";
import { generateProof, type CircuitConfig } from "./proof.helper.js";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

// Verifier deployed by sunspot
const ZK_VERIFIER_PROGRAM_ID = address(requireEnv("ZK_VERIFIER_PROGRAM_ID"));

// Our Pinocchio Shielded Pool Program
const SHIELDED_POOL_PROGRAM_ID = address(requireEnv("SHIELDED_POOL_PROGRAM_ID"));

const repoRoot = path.join(process.cwd(), "..");
const circuitConfig: CircuitConfig = {
    circuitDir: path.join(repoRoot, "noir_circuit"),
    circuitName: "shielded_pool",
};

const keypairDir = path.join(repoRoot, "keypair");
const senderWalletPath = path.join(keypairDir, "sender.json");

const INSTRUCTION = {
    INITIALIZE: 0,
    DEPOSIT: 1,
    WITHDRAW: 2,
};

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

function randomField(): bigint {
    // Use 31 bytes to stay safely within BN254 field range.
    const bytes = crypto.randomBytes(31);
    return BigInt("0x" + bytes.toString("hex"));
}

function logBusinessAccounts(label: string, accounts: Array<{ name: string; address: Address }>) {
    console.log(label);
    for (const account of accounts) {
        console.log(`  - ${account.name}: ${account.address}`);
    }
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
) {
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
    console.log(`✅ ${label} Success! TX: ${sigText}`);
}

async function expectFailure(
    sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
    rpc: ReturnType<typeof createSolanaRpc>,
    feePayer: KeyPairSigner,
    signers: KeyPairSigner[],
    instruction: Instruction,
    label: string
) {
    console.log(`\n${label}`);
    try {
        await sendTransaction(sendAndConfirm, rpc, feePayer, signers, [instruction], 600_000, label);
        console.log("  ⚠️ Unexpected success");
    } catch (err: any) {
        console.log("  ✅ Expected failure");
        if (err.context?.logs) {
            err.context.logs.forEach((l: string) => console.log(`  ${l}`));
        } else {
            console.log(`  Error: ${err.message || err}`);
        }
    }
}

async function main() {
    console.log("=== Shielded Pool Integration Test (Pinocchio + Noir) ===\n");

    await initPoseidon();
    const rpc = createSolanaRpc(RPC_URL);
    const rpcSubscriptions = createSolanaRpcSubscriptions(
        RPC_URL.replace("https://", "wss://").replace("http://", "ws://")
    );
    const sendAndConfirm = sendAndConfirmTransactionFactory({
        rpc,
        rpcSubscriptions,
    });

    const sender = await loadKeypair(senderWalletPath);
    const relayerWalletPath = path.join(keypairDir, "relayer.json");
    const relayer = await loadKeypair(relayerWalletPath);
    console.log(`Sender: ${sender.address}`);
    console.log(`Relayer: ${relayer.address}`);
    console.log(`Verifier Program: ${ZK_VERIFIER_PROGRAM_ID}`);
    console.log(`Shielded Pool Program: ${SHIELDED_POOL_PROGRAM_ID}`);

    const recipientSigner = await generateKeyPairSigner();
    const recipientPubkey = recipientSigner.address;

    // 1. Off-chain State
    const mt = new ShieldedPoolMerkleTree();
    const secret = randomField();
    const nullifierKey = randomField();
    const amount = 1_000_000n; // 0.001 SOL

    const commitment = poseidonHash3(secret, nullifierKey, amount);
    const index = mt.insert(commitment);
    const root = mt.getRoot();
    const nullifier = poseidonHash2(nullifierKey, BigInt(index));

    console.log(`Commitment: ${fieldToHex(commitment)}`);
    console.log(`Nullifier:  ${fieldToHex(nullifier)}`);
    console.log(`Root:       ${fieldToHex(root)}`);
    console.log(`Recipient:  ${recipientPubkey}`);
    console.log(`Amount:     ${amount} lamports`);

    // 2. Generate Proof
    console.log("\nGenerating ZK Proof...");
    const recipientField = recipientFieldFromPubkey(recipientPubkey);

    const proofResult = generateProof(circuitConfig, {
        root: fieldToHex(root),
        nullifier: fieldToHex(nullifier),
        recipient: recipientField,
        amount: Number(amount),
        secret: fieldToHex(secret),
        nullifier_key: fieldToHex(nullifierKey),
        index: index,
        siblings: mt.getProof(index).map(fieldToHex),
    });
    console.log("Proof generated!");
    if (proofResult.proof.length !== 388 || proofResult.publicWitness.length !== 140) {
        throw new Error(
            `Unexpected proof/witness length: proof=${proofResult.proof.length}, witness=${proofResult.publicWitness.length}`
        );
    }

    // 3. Derive PDAs (simulated for test)
    console.log("\nPreparing Transaction...");
    const [statePda] = await getProgramDerivedAddress({
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        seeds: [new TextEncoder().encode("pool_state")],
    });
    const [vaultPda] = await getProgramDerivedAddress({
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        seeds: [new TextEncoder().encode("vault")],
    });

    // Nullifier PDA: ["nullifier", nullifier_hash]
    const nullifierBytes = Buffer.from(nullifier.toString(16).padStart(64, '0'), 'hex');
    const [nullifierPda] = await getProgramDerivedAddress({
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        seeds: [new TextEncoder().encode("nullifier"), nullifierBytes],
    });
    console.log(`State PDA:  ${statePda}`);
    console.log(`Vault PDA:  ${vaultPda}`);
    console.log(`Nullifier:  ${nullifierPda}`);

    const initIx = {
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        accounts: [
            { address: relayer.address, role: 3 },
            { address: statePda, role: 1 },
            { address: vaultPda, role: 1 },
            { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
        ],
        data: new Uint8Array([INSTRUCTION.INITIALIZE]),
    };
    const initAccounts = [
        { name: "fee_payer", address: relayer.address },
        { name: "state_pda", address: statePda },
        { name: "vault_pda", address: vaultPda },
        { name: "system_program", address: SYSTEM_PROGRAM_ADDRESS },
    ];

    const depositData = new Uint8Array(1 + 8 + 32 + 32);
    depositData[0] = INSTRUCTION.DEPOSIT;
    depositData.set(u64ToLeBytes(amount), 1);
    depositData.set(fieldToBytes(commitment), 1 + 8);
    depositData.set(fieldToBytes(root), 1 + 8 + 32);

    const depositIx = {
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        accounts: [
            { address: sender.address, role: 3 },
            { address: statePda, role: 1 },
            { address: vaultPda, role: 1 },
            { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
        ],
        data: depositData,
    };
    const depositAccounts = [
        { name: "sender", address: sender.address },
        { name: "state_pda", address: statePda },
        { name: "vault_pda", address: vaultPda },
        { name: "system_program", address: SYSTEM_PROGRAM_ADDRESS },
    ];

    // Withdraw instruction data: [WITHDRAW, proof (388), witness (140)]
    const data = new Uint8Array(1 + proofResult.proof.length + proofResult.publicWitness.length);
    data[0] = INSTRUCTION.WITHDRAW;
    data.set(proofResult.proof, 1);
    data.set(proofResult.publicWitness, 1 + proofResult.proof.length);

    const withdrawIx = {
        programAddress: SHIELDED_POOL_PROGRAM_ID,
        accounts: [
            { address: relayer.address, role: 3 },  // fee payer (relayer)
            { address: recipientPubkey, role: 1 },  // recipient
            { address: vaultPda, role: 1 },         // vault
            { address: statePda, role: 1 },         // state
            { address: nullifierPda, role: 1 },     // nullifier
            { address: ZK_VERIFIER_PROGRAM_ID, role: 0 },
            { address: SYSTEM_PROGRAM_ADDRESS, role: 0 },
        ],
        data,
    };
    const withdrawAccounts = [
        { name: "fee_payer", address: relayer.address },
        { name: "recipient", address: recipientPubkey },
        { name: "vault_pda", address: vaultPda },
        { name: "state_pda", address: statePda },
        { name: "nullifier_pda", address: nullifierPda },
        { name: "verifier_program", address: ZK_VERIFIER_PROGRAM_ID },
        { name: "system_program", address: SYSTEM_PROGRAM_ADDRESS },
    ];

    logBusinessAccounts("\nInitialize Accounts:", initAccounts);
    console.log("Sending Initialize Transaction...");
    try {
        await sendTransaction(sendAndConfirm, rpc, relayer, [], [initIx], 200_000, "Initialize");
    } catch (err: any) {
        console.log("\n❌ Initialize Failed (Expected if programs not yet deployed)");
        if (err.context?.logs) {
            err.context.logs.forEach((l: string) => console.log(`  ${l}`));
        } else {
            console.log(`  Error: ${err.message || err}`);
        }
    }

    logBusinessAccounts("\nDeposit Accounts:", depositAccounts);
    console.log("Sending Deposit Transaction...");
    try {
        await sendTransaction(sendAndConfirm, rpc, relayer, [sender], [depositIx], 200_000, "Deposit");
    } catch (err: any) {
        console.log("\n❌ Deposit Failed (Expected if programs not yet deployed)");
        if (err.context?.logs) {
            err.context.logs.forEach((l: string) => console.log(`  ${l}`));
        } else {
            console.log(`  Error: ${err.message || err}`);
        }
    }

    const corruptedProof = Uint8Array.from(proofResult.proof);
    corruptedProof[0] ^= 0xff;
    const corruptedData = new Uint8Array(1 + corruptedProof.length + proofResult.publicWitness.length);
    corruptedData[0] = INSTRUCTION.WITHDRAW;
    corruptedData.set(corruptedProof, 1);
    corruptedData.set(proofResult.publicWitness, 1 + corruptedProof.length);
    const corruptedWithdrawIx = { ...withdrawIx, data: corruptedData };

    const wrongRecipientSigner = await generateKeyPairSigner();
    const wrongRecipientIx = {
        ...withdrawIx,
        accounts: withdrawIx.accounts.map((account, index) =>
            index === 1 ? { ...account, address: wrongRecipientSigner.address } : account
        ),
    };

    await expectFailure(
        sendAndConfirm,
        rpc,
        relayer,
        [],
        corruptedWithdrawIx,
        "Expected Failure: Invalid Proof"
    );
    await expectFailure(
        sendAndConfirm,
        rpc,
        relayer,
        [],
        wrongRecipientIx,
        "Expected Failure: Recipient Mismatch"
    );

    logBusinessAccounts("\nWithdraw Accounts:", withdrawAccounts);
    console.log("Sending Withdrawal Transaction...");
    try {
        await sendTransaction(sendAndConfirm, rpc, relayer, [], [withdrawIx], 600_000, "Withdrawal");
    } catch (err: any) {
        console.log("\n❌ Withdrawal Failed (Expected if programs not yet deployed)");
        if (err.context?.logs) {
            err.context.logs.forEach((l: string) => console.log(`  ${l}`));
        } else {
            console.log(`  Error: ${err.message || err}`);
        }
    }

    await expectFailure(
        sendAndConfirm,
        rpc,
        relayer,
        [],
        withdrawIx,
        "Expected Failure: Double Spend (Nullifier Reuse)"
    );
}

main().catch(console.error);

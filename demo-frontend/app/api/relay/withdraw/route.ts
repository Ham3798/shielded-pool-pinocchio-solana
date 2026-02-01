import { NextRequest, NextResponse } from "next/server";
import {
  Keypair,
  Connection,
  Transaction,
  PublicKey,
  ComputeBudgetProgram,
  TransactionInstruction,
  sendAndConfirmTransaction,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// Server-only: Relayer secret key from environment or file
const RELAYER_SECRET_KEY = process.env.RELAYER_SECRET_KEY;
const RELAYER_KEYPAIR_PATH = process.env.RELAYER_KEYPAIR_PATH;
const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Address Lookup Table (ALT) for transaction compression
const LOOKUP_TABLE_ADDRESS =
  process.env.LOOKUP_TABLE_ADDRESS ||
  "9Q7GoBP5Y1TBMbyfNpszzeL3azWbeW3FHzmbwH39YTPt";

// Program IDs
const SHIELDED_POOL_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SHIELDED_POOL_PROGRAM_ID ||
    "H76rmbsE6HxkDw7AWEJLtqYogyP6psq3Fk2wqPH7Cjes"
);
const ZK_VERIFIER_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ZK_VERIFIER_PROGRAM_ID ||
    "3qfJCYMTnPwFgSX1T3Ncem6b5DphHtNoMmgyVeb52Yti"
);
const AUDIT_VERIFIER_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_AUDIT_VERIFIER_PROGRAM_ID ||
    "2A6wr286RiTEYXVjrqmU87xCNG6nusU5rM8ynSbvfdqb"
);
const SYSTEM_PROGRAM_ID = new PublicKey(
  "11111111111111111111111111111111"
);

interface WithdrawRelayRequest {
  recipientAddress: string;
  nullifierPda: string;
  withdrawProofHex: string;
  withdrawWitnessHex: string;
  auditProofHex: string;
  auditWitnessHex: string;
}

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const evenHex = cleanHex.length % 2 === 0 ? cleanHex : "0" + cleanHex;
  return new Uint8Array(Buffer.from(evenHex, "hex"));
}

function loadRelayerKeypair(): Keypair {
  // Try loading from environment variable first
  if (RELAYER_SECRET_KEY) {
    const secretBytes = JSON.parse(RELAYER_SECRET_KEY);
    return Keypair.fromSecretKey(Uint8Array.from(secretBytes));
  }

  // Try loading from file path
  if (RELAYER_KEYPAIR_PATH) {
    const keypairPath = path.resolve(RELAYER_KEYPAIR_PATH);
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(keypairData));
  }

  // Default: try loading from project root
  const defaultPath = path.resolve(
    process.cwd(),
    "../keypair/relayer.json"
  );
  if (fs.existsSync(defaultPath)) {
    const keypairData = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(keypairData));
  }

  throw new Error("Relayer keypair not configured");
}

export async function POST(request: NextRequest) {
  try {
    // Load relayer keypair
    const relayer = loadRelayerKeypair();
    console.log("Relayer address:", relayer.publicKey.toBase58());

    // Parse request body
    const body: WithdrawRelayRequest = await request.json();
    const {
      recipientAddress,
      nullifierPda,
      withdrawProofHex,
      withdrawWitnessHex,
      auditProofHex,
      auditWitnessHex,
    } = body;

    // Validate inputs
    if (
      !recipientAddress ||
      !nullifierPda ||
      !withdrawProofHex ||
      !withdrawWitnessHex ||
      !auditProofHex ||
      !auditWitnessHex
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Setup connection
    const connection = new Connection(RPC_URL, "confirmed");

    // Convert hex to bytes
    const withdrawProofBytes = hexToBytes(withdrawProofHex);
    const withdrawWitnessBytes = hexToBytes(withdrawWitnessHex);
    const auditProofBytes = hexToBytes(auditProofHex);
    const auditWitnessBytes = hexToBytes(auditWitnessHex);

    // Build instructions
    
    // 1. Submit Audit Record
    // Layout: [SUBMIT_AUDIT(3)][audit_proof][audit_witness]
    // Witness contains wa_commitment at offset 12 (used for PDA derivation)
    
    // Extract wa_commitment from audit witness
    // Audit Witness: [12 bytes header] + [32 bytes wa] + [32 bytes ct]
    const AUDIT_WITNESS_HEADER = 12;
    const waCommitmentBytes = auditWitnessBytes.slice(
      AUDIT_WITNESS_HEADER,
      AUDIT_WITNESS_HEADER + 32
    );

    const [auditRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit"), waCommitmentBytes],
      SHIELDED_POOL_PROGRAM_ID
    );

    const INSTRUCTION_SUBMIT_AUDIT = 3;
    const auditDataLen = 1 + auditProofBytes.length + auditWitnessBytes.length;
    const auditData = new Uint8Array(auditDataLen);
    let auditOffset = 0;
    auditData[auditOffset++] = INSTRUCTION_SUBMIT_AUDIT;
    auditData.set(auditProofBytes, auditOffset); auditOffset += auditProofBytes.length;
    auditData.set(auditWitnessBytes, auditOffset);

    const submitAuditIx = new TransactionInstruction({
      programId: SHIELDED_POOL_PROGRAM_ID,
      keys: [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: auditRecordPda, isSigner: false, isWritable: true },
        { pubkey: AUDIT_VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(auditData)
    });

    // 2. Withdraw
    // Layout: [WITHDRAW(2)] + [withdraw_proof] + [withdraw_witness] (Audit proof removed)
    const INSTRUCTION_WITHDRAW = 2;
    const withdrawDataLen =
      1 +
      withdrawProofBytes.length +
      withdrawWitnessBytes.length;
    const withdrawData = new Uint8Array(withdrawDataLen);
    let offset = 0;
    withdrawData[offset++] = INSTRUCTION_WITHDRAW;
    withdrawData.set(withdrawProofBytes, offset);
    offset += withdrawProofBytes.length;
    withdrawData.set(withdrawWitnessBytes, offset);

    // Derive PDAs
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      SHIELDED_POOL_PROGRAM_ID
    );
    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_state")],
      SHIELDED_POOL_PROGRAM_ID
    );

    // Build withdraw instruction with 8 accounts (updated)
    // Keys: [payer, recipient, vault, state, nullifier, zk_verifier, audit_record, system_program]
    const withdrawIx = new TransactionInstruction({
      programId: SHIELDED_POOL_PROGRAM_ID,
      keys: [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true }, // payer
        {
          pubkey: new PublicKey(recipientAddress),
          isSigner: false,
          isWritable: true,
        }, // recipient
        { pubkey: vaultPda, isSigner: false, isWritable: true }, // vault
        { pubkey: statePda, isSigner: false, isWritable: true }, // state
        {
          pubkey: new PublicKey(nullifierPda),
          isSigner: false,
          isWritable: true,
        }, // nullifier
        { pubkey: ZK_VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false }, // zk_verifier
        {
          pubkey: auditRecordPda,
          isSigner: false,
          isWritable: false, // Read-only check in withdraw
        }, // audit_record (New)
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, // system_program
      ],
      data: Buffer.from(withdrawData),
    });

    // Send Transactions
    // We send two separate transactions to ensure they fit and to avoid complex composition issues.
    // However, for atomic-like behavior from user perspective, we chain them.
    // If Audit fails (e.g. invalid proof), Withdraw won't run.
    // If Audit succeeds (or already exists), Withdraw runs.

    // Fetch Address Lookup Table
    const lookupTableAccount = await connection
      .getAddressLookupTable(new PublicKey(LOOKUP_TABLE_ADDRESS))
      .then((res) => res.value);

    if (!lookupTableAccount) {
      throw new Error(`Address Lookup Table not found: ${LOOKUP_TABLE_ADDRESS}`);
    }

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");

    // --- Tx 1: Submit Audit ---
    console.log("Sending Audit Transaction...");
    const auditMessageV0 = new TransactionMessage({
      payerKey: relayer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        submitAuditIx,
      ],
    }).compileToV0Message([lookupTableAccount]);
    
    const auditTx = new VersionedTransaction(auditMessageV0);
    auditTx.sign([relayer]);
    
    // We attempt to send. If it fails because account already exists, we proceed.
    let auditSignature = "";
    try {
        auditSignature = await connection.sendTransaction(auditTx, {
            skipPreflight: true, // We handle errors manually or let it fail if crucial
        });
        await connection.confirmTransaction({
             signature: auditSignature,
             blockhash,
             lastValidBlockHeight
        });
        console.log("Audit confirmed:", auditSignature);
    } catch (e) {
        console.log("Audit transaction failed (might be already initialized):", e);
        // We assume it might be "already initialized" and proceed to withdraw.
        // If it failed for other reasons (invalid proof), Withdraw will fail anyway.
    }

    // --- Tx 2: Withdraw ---
    console.log("Sending Withdraw Transaction...");
    const withdrawMessageV0 = new TransactionMessage({
      payerKey: relayer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        withdrawIx,
      ],
    }).compileToV0Message([lookupTableAccount]);

    const withdrawTx = new VersionedTransaction(withdrawMessageV0);
    withdrawTx.sign([relayer]);

    const withdrawSignature = await connection.sendTransaction(withdrawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
    });

    await connection.confirmTransaction({
        signature: withdrawSignature,
        blockhash,
        lastValidBlockHeight
    });

    console.log("Withdraw confirmed:", withdrawSignature);

    return NextResponse.json({
      success: true,
      signature: withdrawSignature,
      auditSignature: auditSignature,
      relayerAddress: relayer.publicKey.toBase58(),
      message: "Withdraw completed via relayer",
    });
  } catch (error) {
    console.error("Relayer error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

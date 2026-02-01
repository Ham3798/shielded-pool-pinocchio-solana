import { NextRequest, NextResponse } from "next/server";
import {
  Keypair,
  Connection,
  Transaction,
  PublicKey,
  ComputeBudgetProgram,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// Server-only: Relayer secret key from environment or file
const RELAYER_SECRET_KEY = process.env.RELAYER_SECRET_KEY;
const RELAYER_KEYPAIR_PATH = process.env.RELAYER_KEYPAIR_PATH;
const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

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
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
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

    // Build instruction data: [WITHDRAW(2)] + [withdraw_proof] + [withdraw_witness] + [audit_proof] + [audit_witness]
    const INSTRUCTION_WITHDRAW = 2;
    const dataLen =
      1 +
      withdrawProofBytes.length +
      withdrawWitnessBytes.length +
      auditProofBytes.length +
      auditWitnessBytes.length;
    const data = new Uint8Array(dataLen);
    let offset = 0;
    data[offset++] = INSTRUCTION_WITHDRAW;
    data.set(withdrawProofBytes, offset);
    offset += withdrawProofBytes.length;
    data.set(withdrawWitnessBytes, offset);
    offset += withdrawWitnessBytes.length;
    data.set(auditProofBytes, offset);
    offset += auditProofBytes.length;
    data.set(auditWitnessBytes, offset);

    // Derive PDAs
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      SHIELDED_POOL_PROGRAM_ID
    );
    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_state")],
      SHIELDED_POOL_PROGRAM_ID
    );

    // Build withdraw instruction with 8 accounts
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
          pubkey: AUDIT_VERIFIER_PROGRAM_ID,
          isSigner: false,
          isWritable: false,
        }, // audit_verifier
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, // system_program
      ],
      data: Buffer.from(data),
    });

    // Build transaction with compute budget
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }));
    tx.add(withdrawIx);

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = relayer.publicKey;

    // Sign and send
    console.log("Sending transaction...");
    const signature = await sendAndConfirmTransaction(connection, tx, [relayer], {
      commitment: "confirmed",
    });

    console.log("Transaction confirmed:", signature);

    return NextResponse.json({
      success: true,
      signature,
      relayerAddress: relayer.publicKey.toBase58(),
      message: "Withdraw completed via relayer",
    });
  } catch (error) {
    console.error("Relayer error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

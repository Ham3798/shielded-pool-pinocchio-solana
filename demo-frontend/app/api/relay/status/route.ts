import { NextResponse } from "next/server";
import { Keypair, Connection } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const RELAYER_SECRET_KEY = process.env.RELAYER_SECRET_KEY;
const RELAYER_KEYPAIR_PATH = process.env.RELAYER_KEYPAIR_PATH;
const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

const LAMPORTS_PER_SOL = 1_000_000_000;
const LOW_BALANCE_THRESHOLD_SOL = 0.01;

function loadRelayerKeypair(): Keypair | null {
  try {
    if (RELAYER_SECRET_KEY) {
      const secretBytes = JSON.parse(RELAYER_SECRET_KEY);
      return Keypair.fromSecretKey(Uint8Array.from(secretBytes));
    }
    if (RELAYER_KEYPAIR_PATH) {
      const keypairPath = path.resolve(RELAYER_KEYPAIR_PATH);
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      return Keypair.fromSecretKey(Uint8Array.from(keypairData));
    }
    const defaultPath = path.resolve(process.cwd(), "../keypair/relayer.json");
    if (fs.existsSync(defaultPath)) {
      const keypairData = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
      return Keypair.fromSecretKey(Uint8Array.from(keypairData));
    }
  } catch {
    // ignore
  }
  return null;
}

export async function GET() {
  const relayer = loadRelayerKeypair();
  if (!relayer) {
    return NextResponse.json(
      { error: "Relayer not configured" },
      { status: 503 }
    );
  }

  const connection = new Connection(RPC_URL);
  const balanceLamports = await connection.getBalance(relayer.publicKey);
  const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

  return NextResponse.json({
    relayerAddress: relayer.publicKey.toBase58(),
    balanceLamports,
    balanceSol,
    lowBalance: balanceSol < LOW_BALANCE_THRESHOLD_SOL,
  });
}


import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  AddressLookupTableProgram,
  sendAndConfirmTransaction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config
const RPC_URL = "https://api.devnet.solana.com";
const SHIELDED_POOL_PROGRAM_ID = new PublicKey("H76rmbsE6HxkDw7AWEJLtqYogyP6psq3Fk2wqPH7Cjes");
const ZK_VERIFIER_PROGRAM_ID = new PublicKey("3qfJCYMTnPwFgSX1T3Ncem6b5DphHtNoMmgyVeb52Yti");
const AUDIT_VERIFIER_PROGRAM_ID = new PublicKey("2A6wr286RiTEYXVjrqmU87xCNG6nusU5rM8ynSbvfdqb");

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  // Load Relayer Keypair (Local for setup)
  const relayerPath = path.join(__dirname, "..", "keypair", "relayer.json");
  if (!fs.existsSync(relayerPath)) {
    throw new Error(`Relayer keypair not found at ${relayerPath}`);
  }
  const relayerData = JSON.parse(fs.readFileSync(relayerPath, "utf-8"));
  const relayer = Keypair.fromSecretKey(new Uint8Array(relayerData));
  console.log("Relayer (Payer):", relayer.publicKey.toBase58());

  // Derive PDAs to include in ALT
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    SHIELDED_POOL_PROGRAM_ID
  );
  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    SHIELDED_POOL_PROGRAM_ID
  );

  console.log("Vault PDA:", vaultPda.toBase58());
  console.log("State PDA:", statePda.toBase58());

  // 1. Create ALT
  const [lookupTableInst, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: relayer.publicKey,
    payer: relayer.publicKey,
    recentSlot: await connection.getSlot(),
  });

  console.log("Creating Address Lookup Table:", lookupTableAddress.toBase58());

  // 2. Extend ALT with static addresses
  const addressesToAdd = [
    relayer.publicKey,            // Payer
    vaultPda,                     // Pool Vault
    statePda,                     // Pool State
    SHIELDED_POOL_PROGRAM_ID,     // Main Program
    ZK_VERIFIER_PROGRAM_ID,       // ZK Program
    AUDIT_VERIFIER_PROGRAM_ID,    // Audit Program
    SystemProgram.programId,      // System Program
    ComputeBudgetProgram.programId // Compute Budget
  ];

  const extendInst = AddressLookupTableProgram.extendLookupTable({
    payer: relayer.publicKey,
    authority: relayer.publicKey,
    lookupTable: lookupTableAddress,
    addresses: addressesToAdd,
  });

  // Combine into one transaction
  const tx = new Transaction().add(lookupTableInst, extendInst);
  
  console.log("Sending transaction...");
  try {
      const signature = await sendAndConfirmTransaction(connection, tx, [relayer]);
      console.log("Transaction confirmed:", signature);
      console.log("----------------------------------------");
      console.log("ADDRESS LOOKUP TABLE CREATED:");
      console.log(lookupTableAddress.toBase58());
      console.log("----------------------------------------");
  } catch (e) {
      console.error("Error creating ALT:", e);
  }
}

main().catch(console.error);

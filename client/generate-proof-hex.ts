/**
 * CLI helper script to convert proof files to hex format for browser UI
 * 
 * Usage:
 *   cd client
 *   npx tsx generate-proof-hex.ts
 * 
 * Prerequisites:
 *   1. Run `nargo execute` in noir_circuit/
 *   2. Run `sunspot prove` to generate proof files
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOIR_CIRCUIT_TARGET = path.join(__dirname, "..", "noir_circuit", "target");

const proofPath = path.join(NOIR_CIRCUIT_TARGET, "shielded_pool_verifier.proof");
const witnessPath = path.join(NOIR_CIRCUIT_TARGET, "shielded_pool_verifier.pw");

function main() {
  console.log("=".repeat(60));
  console.log("Shielded Pool - Proof to Hex Converter");
  console.log("=".repeat(60));
  console.log();

  // Check if files exist
  if (!fs.existsSync(proofPath)) {
    console.error(`Error: Proof file not found at ${proofPath}`);
    console.error("\nMake sure you have run:");
    console.error("  cd noir_circuit");
    console.error("  nargo execute");
    console.error("  sunspot prove target/shielded_pool_verifier.json ...");
    process.exit(1);
  }

  if (!fs.existsSync(witnessPath)) {
    console.error(`Error: Witness file not found at ${witnessPath}`);
    process.exit(1);
  }

  // Read files
  const proofBytes = fs.readFileSync(proofPath);
  const witnessBytes = fs.readFileSync(witnessPath);

  console.log(`Proof file: ${proofPath}`);
  console.log(`Proof size: ${proofBytes.length} bytes`);
  console.log();
  console.log(`Witness file: ${witnessPath}`);
  console.log(`Witness size: ${witnessBytes.length} bytes`);
  console.log();

  console.log("=".repeat(60));
  console.log("PROOF (hex) - Copy this to the 'Proof' field in the UI:");
  console.log("=".repeat(60));
  console.log();
  console.log("0x" + proofBytes.toString("hex"));
  console.log();

  console.log("=".repeat(60));
  console.log("PUBLIC WITNESS (hex) - Copy this to the 'Public Witness' field:");
  console.log("=".repeat(60));
  console.log();
  console.log("0x" + witnessBytes.toString("hex"));
  console.log();

  console.log("=".repeat(60));
  console.log("Instructions:");
  console.log("=".repeat(60));
  console.log("1. Copy the PROOF hex above");
  console.log("2. Paste it into the 'Proof (hex)' field in the browser");
  console.log("3. Copy the PUBLIC WITNESS hex above");
  console.log("4. Paste it into the 'Public Witness (hex)' field");
  console.log("5. Verify the recipient address is correct");
  console.log("6. Click 'Submit Withdraw'");
  console.log();
}

main();

/**
 * CLI helper script to convert proof files to hex format for browser UI
 *
 * Usage:
 *   cd client
 *   npx tsx generate-proof-hex.ts
 *
 * Prerequisites:
 *   1. Run `nargo execute` in noir_circuit/ and audit_circuit/
 *   2. Run `sunspot prove` in both directories to generate proof files
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOIR_CIRCUIT_TARGET = path.join(__dirname, "..", "noir_circuit", "target");
const AUDIT_CIRCUIT_TARGET = path.join(__dirname, "..", "audit_circuit", "target");

// Withdraw proof files
const withdrawProofPath = path.join(NOIR_CIRCUIT_TARGET, "shielded_pool_verifier.proof");
const withdrawWitnessPath = path.join(NOIR_CIRCUIT_TARGET, "shielded_pool_verifier.pw");

// Audit proof files
const auditProofPath = path.join(AUDIT_CIRCUIT_TARGET, "rlwe_audit.proof");
const auditWitnessPath = path.join(AUDIT_CIRCUIT_TARGET, "rlwe_audit.pw");

function main() {
  console.log("=".repeat(60));
  console.log("Shielded Pool - Proof to Hex Converter");
  console.log("=".repeat(60));
  console.log();

  // Check withdraw proof files
  if (!fs.existsSync(withdrawProofPath)) {
    console.error(`Error: Withdraw proof file not found at ${withdrawProofPath}`);
    console.error("\nMake sure you have run:");
    console.error("  cd noir_circuit");
    console.error("  nargo execute");
    console.error("  sunspot prove target/shielded_pool_verifier.json ...");
    process.exit(1);
  }

  if (!fs.existsSync(withdrawWitnessPath)) {
    console.error(`Error: Withdraw witness file not found at ${withdrawWitnessPath}`);
    process.exit(1);
  }

  // Check audit proof files
  if (!fs.existsSync(auditProofPath)) {
    console.error(`Error: Audit proof file not found at ${auditProofPath}`);
    console.error("\nMake sure you have run:");
    console.error("  cd audit_circuit");
    console.error("  nargo execute");
    console.error("  sunspot prove target/rlwe_audit.json ...");
    process.exit(1);
  }

  if (!fs.existsSync(auditWitnessPath)) {
    console.error(`Error: Audit witness file not found at ${auditWitnessPath}`);
    process.exit(1);
  }

  // Read all files
  const withdrawProofBytes = fs.readFileSync(withdrawProofPath);
  const withdrawWitnessBytes = fs.readFileSync(withdrawWitnessPath);
  const auditProofBytes = fs.readFileSync(auditProofPath);
  const auditWitnessBytes = fs.readFileSync(auditWitnessPath);

  console.log("Withdraw proof file: " + withdrawProofPath);
  console.log(`Withdraw proof size: ${withdrawProofBytes.length} bytes`);
  console.log("Withdraw witness file: " + withdrawWitnessPath);
  console.log(`Withdraw witness size: ${withdrawWitnessBytes.length} bytes`);
  console.log();
  console.log("Audit proof file: " + auditProofPath);
  console.log(`Audit proof size: ${auditProofBytes.length} bytes`);
  console.log("Audit witness file: " + auditWitnessPath);
  console.log(`Audit witness size: ${auditWitnessBytes.length} bytes`);
  console.log();

  console.log("=".repeat(60));
  console.log("1. WITHDRAW PROOF (hex):");
  console.log("=".repeat(60));
  console.log();
  console.log("0x" + withdrawProofBytes.toString("hex"));
  console.log();

  console.log("=".repeat(60));
  console.log("2. WITHDRAW PUBLIC WITNESS (hex):");
  console.log("=".repeat(60));
  console.log();
  console.log("0x" + withdrawWitnessBytes.toString("hex"));
  console.log();

  console.log("=".repeat(60));
  console.log("3. AUDIT PROOF (hex):");
  console.log("=".repeat(60));
  console.log();
  console.log("0x" + auditProofBytes.toString("hex"));
  console.log();

  console.log("=".repeat(60));
  console.log("4. AUDIT PUBLIC WITNESS (hex):");
  console.log("=".repeat(60));
  console.log();
  console.log("0x" + auditWitnessBytes.toString("hex"));
  console.log();

  console.log("=".repeat(60));
  console.log("Instructions:");
  console.log("=".repeat(60));
  console.log("1. Copy WITHDRAW PROOF hex -> paste into 'Proof (hex)' field");
  console.log("2. Copy WITHDRAW PUBLIC WITNESS hex -> paste into 'Public Witness (hex)' field");
  console.log("3. Copy AUDIT PROOF hex -> paste into 'Audit Proof (hex)' field");
  console.log("4. Copy AUDIT PUBLIC WITNESS hex -> paste into 'Audit Public Witness (hex)' field");
  console.log("5. Verify the recipient address matches the one used in Prover.toml");
  console.log("6. Click 'Submit via Relayer'");
  console.log();
}

main();

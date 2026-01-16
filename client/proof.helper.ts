import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export interface ShieldedPoolInputs {
    root: string;
    nullifier: string;
    recipient: string;
    amount: number | string;
    secret: string;
    nullifier_key: string;
    index: number | string;
    siblings: string[];
}

export interface CircuitConfig {
    circuitDir: string;
    circuitName: string;
}

export function generateProof(config: CircuitConfig, inputs: ShieldedPoolInputs) {
    const proverTomlPath = path.join(config.circuitDir, "Prover.toml");

    // Format TOML
    let toml = "";
    toml += `root = "${inputs.root}"\n`;
    toml += `nullifier = "${inputs.nullifier}"\n`;
    toml += `recipient = "${inputs.recipient}"\n`;
    toml += `amount = ${inputs.amount}\n`;
    toml += `secret = "${inputs.secret}"\n`;
    toml += `nullifier_key = "${inputs.nullifier_key}"\n`;
    toml += `index = ${inputs.index}\n`;
    toml += `siblings = [\n`;
    for (const sib of inputs.siblings) {
        toml += `  "${sib}",\n`;
    }
    toml += `]\n`;

    fs.writeFileSync(proverTomlPath, toml);

    // Run nargo execute
    execSync("nargo execute", { cwd: config.circuitDir });

    // Run sunspot prove
    const targetDir = path.join(config.circuitDir, "target");
    const acirPath = path.join(targetDir, `${config.circuitName}.json`);
    const witnessPath = path.join(targetDir, `${config.circuitName}.gz`);
    const ccsPath = path.join(targetDir, `${config.circuitName}.ccs`);
    const pkPath = path.join(targetDir, `${config.circuitName}.pk`);

    execSync(`sunspot prove ${acirPath} ${witnessPath} ${ccsPath} ${pkPath}`, {
        cwd: config.circuitDir,
    });

    const proof = fs.readFileSync(path.join(targetDir, `${config.circuitName}.proof`));
    const publicWitness = fs.readFileSync(path.join(targetDir, `${config.circuitName}.pw`));

    return { proof, publicWitness };
}

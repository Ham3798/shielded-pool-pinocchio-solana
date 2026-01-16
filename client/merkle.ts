import { buildPoseidon, type Poseidon } from "circomlibjs";

let poseidonInstance: Poseidon | null = null;

export async function initPoseidon(): Promise<void> {
    if (!poseidonInstance) {
        poseidonInstance = await buildPoseidon();
    }
}

function getPoseidon(): Poseidon {
    if (!poseidonInstance) {
        throw new Error("Poseidon not initialized");
    }
    return poseidonInstance;
}

const TREE_DEPTH = 16;

export function poseidonHash2(left: bigint, right: bigint): bigint {
    const poseidon = getPoseidon();
    const hash = poseidon([left, right]);
    return poseidon.F.toObject(hash) as bigint;
}

export function poseidonHash3(v1: bigint, v2: bigint, v3: bigint): bigint {
    const poseidon = getPoseidon();
    const hash = poseidon([v1, v2, v3]);
    return poseidon.F.toObject(hash) as bigint;
}

export class ShieldedPoolMerkleTree {
    private leaves: bigint[] = [];
    private defaultHashes: bigint[];

    constructor() {
        this.defaultHashes = new Array(TREE_DEPTH + 1);
        this.defaultHashes[0] = 0n; // Empty leaf
        for (let i = 1; i <= TREE_DEPTH; i++) {
            const prev = this.defaultHashes[i - 1];
            this.defaultHashes[i] = poseidonHash2(prev, prev);
        }
    }

    insert(commitment: bigint): number {
        const index = this.leaves.length;
        this.leaves.push(commitment);
        return index;
    }

    getRoot(): bigint {
        let currentLevel = [...this.leaves];
        for (let i = 0; i < TREE_DEPTH; i++) {
            const nextLevel: bigint[] = [];
            for (let j = 0; j < Math.pow(2, TREE_DEPTH - i); j += 2) {
                const left = currentLevel[j] ?? this.defaultHashes[i];
                const right = currentLevel[j + 1] ?? this.defaultHashes[i];
                nextLevel.push(poseidonHash2(left, right));
            }
            currentLevel = nextLevel;
        }
        return currentLevel[0];
    }

    /**
     * More efficient root calculation for large indices
     */
    getRootOptimized(): bigint {
        return this.calculateRootAtLevel(TREE_DEPTH, 0);
    }

    private calculateRootAtLevel(level: number, index: number): bigint {
        if (level === 0) {
            return this.leaves[index] ?? 0n;
        }
        const left = this.calculateRootAtLevel(level - 1, index * 2);
        const right = this.calculateRootAtLevel(level - 1, index * 2 + 1);
        return poseidonHash2(left, right);
    }

    getProof(index: number): bigint[] {
        const proof: bigint[] = [];
        let currentIdx = index;

        // We need effectively the state of the tree at each level
        let currentLevel = [...this.leaves];

        for (let i = 0; i < TREE_DEPTH; i++) {
            const isRight = currentIdx % 2 === 1;
            const siblingIdx = isRight ? currentIdx - 1 : currentIdx + 1;

            const sibling = currentLevel[siblingIdx] ?? this.defaultHashes[i];
            proof.push(sibling);

            // Move to next level
            const nextLevel: bigint[] = [];
            for (let j = 0; j < Math.pow(2, TREE_DEPTH - i); j += 2) {
                const left = currentLevel[j] ?? this.defaultHashes[i];
                const right = currentLevel[j + 1] ?? this.defaultHashes[i];
                nextLevel.push(poseidonHash2(left, right));
            }
            currentLevel = nextLevel;
            currentIdx = Math.floor(currentIdx / 2);
        }

        return proof;
    }
}

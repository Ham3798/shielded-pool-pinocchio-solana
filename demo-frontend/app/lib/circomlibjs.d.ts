declare module "circomlibjs" {
  export interface Poseidon {
    (inputs: (bigint | number | string)[]): Uint8Array;
    F: {
      toObject(hash: Uint8Array): bigint;
    };
  }

  export function buildPoseidon(): Promise<Poseidon>;
}

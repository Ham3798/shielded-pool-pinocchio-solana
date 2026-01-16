use dep::poseidon::poseidon::bn254::hash_2 as poseidon_hash;

global TREE_DEPTH: u32 = 16; 

fn poseidon_hash_2(left: Field, right: Field) -> Field {
    poseidon_hash([left, right])
}

fn compute_merkle_root<let N: u32>(leaf: Field, index: Field, siblings: [Field; N]) -> Field {
    let mut current = leaf;
    let path_bits: [u1; N] = index.to_le_bits();

    for i in 0..N {
        let sibling = siblings[i];
        let bit = path_bits[i];

        let (left, right) = if bit == 0 {
            (current, sibling)
        } else {
            (sibling, current)
        };

        current = poseidon_hash_2(left, right);
    }

    current
}

fn main(
    root: pub Field,
    nullifier: pub Field,
    recipient: pub Field, // Binding to recipient (hash of pubkey)
    amount: pub u64,      // Public amount
    
    secret: Field,
    nullifier_key: Field,
    index: Field,
    siblings: [Field; TREE_DEPTH]
) {
    // 1. Commitment = H(secret, nullifier_key, amount)
    // We'll use hash_3 for this: [secret, nullifier_key, amount]
    let commitment = dep::poseidon::poseidon::bn254::hash_3([secret, nullifier_key, amount as Field]);

    // 2. Nullifier = H(nullifier_key, index)
    let calculated_nullifier = poseidon_hash_2(nullifier_key, index);
    assert(nullifier == calculated_nullifier);

    // 3. Merkle membership
    let calculated_root = compute_merkle_root(commitment, index, siblings);
    assert(root == calculated_root);

    // 4. Ensure recipient is used in the circuit to bind the proof
    assert(recipient != 0); 
}

#[test]
fn test_shielded_pool() {
    let secret = 1;
    let nullifier_key = 2;
    let index = 0;
    let amount = 1000000; // 1M lamports
    let mut siblings = [0; TREE_DEPTH];
    
    let commitment = dep::poseidon::poseidon::bn254::hash_3([secret, nullifier_key, amount as Field]);
    let nullifier = poseidon_hash_2(nullifier_key, index);
    let root = compute_merkle_root(commitment, index, siblings);
    let recipient = 123; // dummy recipient hash

    main(root, nullifier, recipient, amount, secret, nullifier_key, index, siblings);
}

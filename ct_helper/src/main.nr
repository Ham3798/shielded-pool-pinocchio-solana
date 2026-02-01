use std::hash::poseidon2_permutation;

global PACKED_C0: u32 = 10;
global PACKED_C1: u32 = 147;
global TOTAL_PACKED: u32 = 157;

fn get_elem(c0_packed: [Field; PACKED_C0], c1_packed: [Field; PACKED_C1], i: u32) -> Field {
    if i < PACKED_C0 {
        c0_packed[i]
    } else {
        c1_packed[i - PACKED_C0]
    }
}

fn main(c0_packed: [Field; PACKED_C0], c1_packed: [Field; PACKED_C1]) -> pub Field {
    // ct_commitment = Poseidon2 sponge over packed Fields (rate=3, capacity=1)
    let mut state: [Field; 4] = [0; 4];
    let full_rounds: u32 = TOTAL_PACKED / 3;
    for i in 0..full_rounds {
        state[0] += get_elem(c0_packed, c1_packed, 3 * i);
        state[1] += get_elem(c0_packed, c1_packed, 3 * i + 1);
        state[2] += get_elem(c0_packed, c1_packed, 3 * i + 2);
        state = poseidon2_permutation(state, 4);
    }
    let remainder = TOTAL_PACKED - full_rounds * 3;
    if remainder >= 1 {
        state[0] += get_elem(c0_packed, c1_packed, full_rounds * 3);
    }
    if remainder >= 2 {
        state[1] += get_elem(c0_packed, c1_packed, full_rounds * 3 + 1);
    }
    state = poseidon2_permutation(state, 4);
    state[0]
}

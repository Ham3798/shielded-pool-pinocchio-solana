use bytemuck::{Pod, Zeroable};
use pinocchio::Address;

/// Global state for the shielded pool
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ShieldedPoolState {
    /// Discriminator to identify account type (e.g., hash of "state")
    pub discriminator: [u8; 8],
    /// Current merkle root of the commitment tree
    pub current_root: [u8; 32],
    /// Circular buffer of the last 32 valid roots
    pub roots: [[u8; 32]; 32],
    /// Current index in the roots buffer (where to write next)
    pub roots_index: u32,
    /// Padding to align to 8 bytes (32*32 bytes + 32 + 8 + 4 = 1024 + 44 = 1068. +4 = 1072)
    pub _padding: [u8; 4],
}

impl ShieldedPoolState {
    pub const LEN: usize = core::mem::size_of::<ShieldedPoolState>();
    pub const DISCRIMINATOR: [u8; 8] = *b"poolstat"; // Simple 8-byte tag

    pub fn is_initialized(&self) -> bool {
        self.discriminator == Self::DISCRIMINATOR
    }

    /// Add a new root to the history and update current root
    pub fn add_root(&mut self, new_root: [u8; 32]) {
        self.current_root = new_root;
        let idx = self.roots_index as usize % 32;
        self.roots[idx] = new_root;
        self.roots_index = self.roots_index.wrapping_add(1);
    }

    /// Check if a root is valid (either current or in history)
    pub fn check_root(&self, root: &[u8; 32]) -> bool {
        if &self.current_root == root {
            return true;
        }
        for r in &self.roots {
            if r == root {
                return true;
            }
        }
        false
    }
}

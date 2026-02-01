use pinocchio::{AccountView, Address, ProgramResult};
use pinocchio_system::instructions::Transfer as SystemTransfer;
use solana_program_error::ProgramError;
use solana_program_log::log;

use crate::state::ShieldedPoolState;

pub fn process_deposit(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    // Accounts: [payer, state, vault, system_program]
    let [payer, state_account, vault, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !state_account.is_writable() || !vault.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // Data layout: [amount: u64] [commitment: [u8; 32]] [new_root: [u8; 32]]
    if data.len() != 72 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64::from_le_bytes(
        data[0..8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let _commitment: [u8; 32] = data[8..40]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let new_root: [u8; 32] = data[40..72]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    log("Processing Deposit");

    // Transfer SOL to the vault.
    SystemTransfer {
        from: payer,
        to: vault,
        lamports: amount,
    }
    .invoke()?;

    // Update the stored Merkle root.
    if state_account.address() != &Address::find_program_address(&[b"pool_state"], &crate::ID).0 {
        return Err(ProgramError::InvalidAccountData);
    }

    if !state_account.owned_by(&crate::ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }

    if vault.address() != &Address::find_program_address(&[b"vault"], &crate::ID).0 {
        return Err(ProgramError::InvalidAccountData);
    }

    if !vault.owned_by(&crate::ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }

    let mut state_data = state_account.try_borrow_mut()?;
    let state: &mut ShieldedPoolState =
        bytemuck::from_bytes_mut(&mut state_data[..ShieldedPoolState::LEN]);

    if !state.is_initialized() {
        return Err(ProgramError::UninitializedAccount);
    }

    state.add_root(new_root);

    log("Deposit successful, root updated");
    Ok(())
}

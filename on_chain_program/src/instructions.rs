use pinocchio::{
    cpi::{invoke, Seed, Signer},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::{CreateAccount, Transfer as SystemTransfer};
use solana_instruction_view::InstructionView;
use solana_program_error::ProgramError;
use solana_program_log::log;

use crate::state::ShieldedPoolState;

pub mod instruction {
    pub const INITIALIZE: u8 = 0;
    pub const DEPOSIT: u8 = 1;
    pub const WITHDRAW: u8 = 2;
}

const PROOF_LEN: usize = 388;
const PUBLIC_INPUTS: usize = 4;
const WITNESS_HEADER_LEN: usize = 12;
const WITNESS_LEN: usize = WITNESS_HEADER_LEN + (PUBLIC_INPUTS * 32);

/// ZK Verifier program ID
pub const ZK_VERIFIER_PROGRAM_ID: Address =
    Address::from_str_const("Co5ivXmsZDqMZk37Kc3yAtW3dNZgkbAwZKePXNBXLh8T");

pub fn process_initialize(accounts: &[AccountView], _data: &[u8]) -> ProgramResult {
    let [payer, state_account, vault, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !state_account.is_writable() || !vault.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // Ensure the state account matches the expected PDA.
    let (pda, bump) = Address::find_program_address(&[b"pool_state"], &crate::ID);
    if state_account.address() != &pda {
        return Err(ProgramError::InvalidAccountData);
    }

    if !state_account.is_data_empty() && !state_account.owned_by(&crate::ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }

    if state_account.is_data_empty() {
        let rent = Rent::get()?;
        let space = ShieldedPoolState::LEN as u64;
        let lamports = rent.try_minimum_balance(space as usize)?;

        let bump_seed = [bump];
        let seeds = [Seed::from(b"pool_state"), Seed::from(&bump_seed)];
        let signer = [Signer::from(&seeds)];

        log("Creating ShieldedPoolState account");
        CreateAccount {
            from: payer,
            to: state_account,
            lamports,
            space,
            owner: &crate::ID,
        }
        .invoke_signed(&signer)?;
    }

    // Initialize state data.
    let mut data = state_account.try_borrow_mut()?;
    let state: &mut ShieldedPoolState =
        bytemuck::from_bytes_mut(&mut data[..ShieldedPoolState::LEN]);

    if state.is_initialized() {
        log("ShieldedPoolState already initialized");
        return Ok(());
    }

    state.discriminator = ShieldedPoolState::DISCRIMINATOR;
    state.current_root = [0u8; 32]; // Initial root is zero.
    state.roots = [[0u8; 32]; 32];
    state.roots_index = 0;
    state._padding = [0u8; 4];

    // Create the vault PDA if missing.
    let (vault_pda, vault_bump) = Address::find_program_address(&[b"vault"], &crate::ID);
    if vault.address() != &vault_pda {
        return Err(ProgramError::InvalidAccountData);
    }

    if vault.lamports() > 0 && !vault.owned_by(&crate::ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }

    if vault.is_data_empty() && vault.lamports() == 0 {
        let rent = Rent::get()?;
        let space = 0u64;
        let lamports = rent.try_minimum_balance(space as usize)?;

        let bump_seed = [vault_bump];
        let seeds = [Seed::from(b"vault"), Seed::from(&bump_seed)];
        let signer = [Signer::from(&seeds)];

        log("Creating vault PDA");
        CreateAccount {
            from: payer,
            to: vault,
            lamports,
            space,
            owner: &crate::ID,
        }
        .invoke_signed(&signer)?;
    }

    log("ShieldedPoolState initialized");
    Ok(())
}

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
    let amount = u64::from_le_bytes(data[0..8].try_into().map_err(|_| {
        ProgramError::InvalidInstructionData
    })?);
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

pub fn process_withdraw(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let [payer, recipient, vault, state_account, nullifier_account, zk_verifier, _system_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !recipient.is_writable()
        || !vault.is_writable()
        || !nullifier_account.is_writable()
        || !state_account.is_writable()
    {
        return Err(ProgramError::InvalidAccountData);
    }

    log("Processing Withdraw");

    // Verify ZK verifier program ID.
    if zk_verifier.address() != &ZK_VERIFIER_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load state and verify the root.
    if !state_account.owned_by(&crate::ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }

    let mut state_data = state_account.try_borrow_mut()?;
    let state: &mut ShieldedPoolState =
        bytemuck::from_bytes_mut(&mut state_data[..ShieldedPoolState::LEN]);

    if !state.is_initialized() {
        return Err(ProgramError::UninitializedAccount);
    }

    // Instruction data layout: [proof][witness].
    // Witness format: 12-byte header + 4 public inputs (32 bytes each).
    // Public inputs (order): root, nullifier, recipient, amount.

    if data.len() != PROOF_LEN + WITNESS_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let proof_len = PROOF_LEN;
    let inputs_start = proof_len + WITNESS_HEADER_LEN;

    let submitted_root: [u8; 32] = data[inputs_start..inputs_start + 32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let submitted_nullifier: [u8; 32] = data[inputs_start + 32..inputs_start + 64]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let submitted_recipient: [u8; 32] = data[inputs_start + 64..inputs_start + 96]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let submitted_amount: [u8; 32] = data[inputs_start + 96..inputs_start + 128]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    // Verify root against state history.
    if !state.check_root(&submitted_root) {
        log("Invalid Merkle Root");
        return Err(ProgramError::InvalidAccountData);
    }

    // Verify nullifier PDA (prevents double spend).
    let (derived_nullifier_pda, bump) =
        Address::find_program_address(&[b"nullifier", &submitted_nullifier], &crate::ID);

    if nullifier_account.address() != &derived_nullifier_pda {
        return Err(ProgramError::InvalidAccountData);
    }

    if nullifier_account.lamports() > 0 {
        log("Nullifier already used");
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Verify recipient encoding used by the client.
    let mut expected_recipient = [0u8; 32];
    expected_recipient[2..32].copy_from_slice(&recipient.address().as_ref()[0..30]);
    if submitted_recipient != expected_recipient {
        return Err(ProgramError::InvalidAccountData);
    }

    // Decode amount from the field element (big-endian, last 8 bytes).
    let amount_u64 = u64::from_be_bytes(
        submitted_amount[24..32]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    // CPI to ZK verifier.
    log("Verifying ZK proof...");
    let proof_data = &data[0..PROOF_LEN];
    let witness_data = &data[PROOF_LEN..];
    let mut verifier_data = [0u8; PROOF_LEN + WITNESS_LEN];
    verifier_data[..PROOF_LEN].copy_from_slice(proof_data);
    verifier_data[PROOF_LEN..].copy_from_slice(witness_data);
    let verify_ix = InstructionView {
        program_id: zk_verifier.address(),
        accounts: &[],
        data: &verifier_data,
    };
    invoke(&verify_ix, &[])?;

    // Initialize nullifier account after proof verification.
    let rent = Rent::get()?;
    let space = 0;
    let lamports = rent.try_minimum_balance(space)?;

    let bump_seed = [bump];
    let seeds = [
        Seed::from(b"nullifier"),
        Seed::from(&submitted_nullifier),
        Seed::from(&bump_seed),
    ];
    let signer = [Signer::from(&seeds)];

    CreateAccount {
        from: payer,
        to: nullifier_account,
        lamports,
        space: 0,
        owner: &crate::ID,
    }
    .invoke_signed(&signer)?;

    // Transfer SOL from the vault to the recipient.
    if vault.address() != &Address::find_program_address(&[b"vault"], &crate::ID).0 {
        return Err(ProgramError::InvalidAccountData);
    }

    if !vault.owned_by(&crate::ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }

    // Keep the vault rent-exempt while withdrawing.
    let data_len = vault.data_len();
    let min_balance = Rent::get()?.try_minimum_balance(data_len)?;
    let withdrawable = vault
        .lamports()
        .checked_sub(min_balance)
        .ok_or(ProgramError::InsufficientFunds)?;
    if amount_u64 > withdrawable {
        return Err(ProgramError::InsufficientFunds);
    }

    let new_vault_balance = vault
        .lamports()
        .checked_sub(amount_u64)
        .ok_or(ProgramError::InsufficientFunds)?;
    let new_recipient_balance = recipient
        .lamports()
        .checked_add(amount_u64)
        .ok_or(ProgramError::InsufficientFunds)?;
    vault.set_lamports(new_vault_balance);
    recipient.set_lamports(new_recipient_balance);

    log("Withdraw successful");
    Ok(())
}

use pinocchio::{
    cpi::{invoke, Seed, Signer},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use solana_instruction_view::InstructionView;
use solana_program_error::ProgramError;
use solana_program_log::log;

use crate::state::{AuditRecord, ShieldedPoolState};

const PROOF_LEN: usize = 388;
const PUBLIC_INPUTS: usize = 5; // root, nullifier, recipient, amount, wa_commitment
const WITNESS_HEADER_LEN: usize = 12;
const WITNESS_LEN: usize = WITNESS_HEADER_LEN + (PUBLIC_INPUTS * 32);

/// ZK Verifier program ID
pub const ZK_VERIFIER_PROGRAM_ID: Address =
    Address::from_str_const("3qfJCYMTnPwFgSX1T3Ncem6b5DphHtNoMmgyVeb52Yti");

pub fn process_withdraw(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    // Keys: [payer, recipient, vault, state, nullifier, zk_verifier, audit_record, system_program]
    // Audit verifier (Account 6) is replaced by audit_record_account (PDA)
    let [payer, recipient, vault, state_account, nullifier_account, zk_verifier, audit_record_account, _system_program] =
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

    // Instruction data layout: [withdraw_proof][withdraw_witness]
    // (Audit proof is removed)
    const TOTAL_DATA_LEN: usize = PROOF_LEN + WITNESS_LEN;
    if data.len() != TOTAL_DATA_LEN {
        log("Invalid instruction data length");
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

    // Extract wa_commitment from withdraw witness (5th public input)
    let wa_commitment_withdraw: [u8; 32] = data[inputs_start + 128..inputs_start + 160]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    // --- Audit Verification Logic (New) ---
    // 1. Verify PDA of audit_record_account using wa_commitment_withdraw
    let (derived_audit_pda, _) =
        Address::find_program_address(&[b"audit", &wa_commitment_withdraw], &crate::ID);

    if audit_record_account.address() != &derived_audit_pda {
        log("Invalid Audit Record PDA");
        return Err(ProgramError::InvalidAccountData);
    }

    if !audit_record_account.owned_by(&crate::ID) {
        log("Audit Record not owned by program");
        return Err(ProgramError::InvalidAccountOwner);
    }

    // 2. Check if Audit Record is initialized and matches
    if audit_record_account.lamports() == 0 {
        log("Audit Record not found (Submission required)");
        return Err(ProgramError::UninitializedAccount);
    }

    let audit_data = audit_record_account.try_borrow()?;
    if audit_data.len() < AuditRecord::LEN {
        return Err(ProgramError::InvalidAccountData);
    }

    let audit_rec: &AuditRecord = bytemuck::from_bytes(&audit_data[..AuditRecord::LEN]);
    if !audit_rec.is_initialized() {
        return Err(ProgramError::UninitializedAccount);
    }
    if audit_rec.wa_commitment != wa_commitment_withdraw {
        log("Audit Record mismatch");
        return Err(ProgramError::InvalidAccountData);
    }

    log("Audit Record verified");
    // --------------------------------------

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

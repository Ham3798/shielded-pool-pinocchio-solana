use pinocchio::{
    cpi::{invoke, Seed, Signer},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use solana_instruction_view::InstructionView;
use solana_program_error::ProgramError;
use solana_program_log::log;

use crate::state::AuditRecord;

/// Audit Verifier program ID (RLWE correctness proof)
pub const AUDIT_VERIFIER_PROGRAM_ID: Address =
    Address::from_str_const("2A6wr286RiTEYXVjrqmU87xCNG6nusU5rM8ynSbvfdqb");

// Audit circuit constants
const AUDIT_PROOF_LEN: usize = 388;
const AUDIT_PUBLIC_INPUTS: usize = 2; // wa_commitment, ct_commitment
const AUDIT_WITNESS_HEADER_LEN: usize = 12;
const AUDIT_WITNESS_LEN: usize = AUDIT_WITNESS_HEADER_LEN + (AUDIT_PUBLIC_INPUTS * 32); // 76 bytes

pub fn process_submit_audit(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let [payer, audit_record_account, audit_verifier, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !audit_record_account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // Verify Audit verifier program ID
    if audit_verifier.address() != &AUDIT_VERIFIER_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Expected data layout: [audit_proof][audit_witness]
    let total_len = AUDIT_PROOF_LEN + AUDIT_WITNESS_LEN;
    if data.len() != total_len {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Extract public inputs from witness
    // Witness layout: [12 bytes header][32 bytes wa_commitment][32 bytes ct_commitment]
    let witness_start = AUDIT_PROOF_LEN;
    let inputs_start = witness_start + AUDIT_WITNESS_HEADER_LEN;

    let wa_commitment: [u8; 32] = data[inputs_start..inputs_start + 32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    // Verify PDA for Audit Record
    // Seeds: ["audit", wa_commitment]
    let (derived_pda, bump) =
        Address::find_program_address(&[b"audit", &wa_commitment], &crate::ID);

    if audit_record_account.address() != &derived_pda {
        return Err(ProgramError::InvalidAccountData);
    }

    // Check if already initialized (Idempotency)
    if audit_record_account.lamports() > 0 {
        let state_data = audit_record_account.try_borrow()?;
        if state_data.len() >= AuditRecord::LEN {
            let record: &AuditRecord = bytemuck::from_bytes(&state_data[..AuditRecord::LEN]);
            if record.is_initialized() && record.wa_commitment == wa_commitment {
                log("Audit record already exists");
                return Ok(());
            }
        }
        // If account exists but data is invalid/uninitialized, we might fail or overwrite.
        // For safety, assume if lamports > 0, it's occupied.
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Verify Audit Proof via CPI
    log("Verifying Audit proof...");
    let verify_ix = InstructionView {
        program_id: audit_verifier.address(),
        accounts: &[],
        data,
    };
    invoke(&verify_ix, &[])?;
    log("Audit proof verified");

    // Initialize Audit Record Account
    let rent = Rent::get()?;
    let space = AuditRecord::LEN;
    let lamports = rent.try_minimum_balance(space)?;

    let bump_seed = [bump];
    let seeds = [
        Seed::from(b"audit"),
        Seed::from(&wa_commitment),
        Seed::from(&bump_seed),
    ];
    let signer = [Signer::from(&seeds)];

    log("Creating Audit Record account...");
    CreateAccount {
        from: payer,
        to: audit_record_account,
        lamports,
        space: space as u64,
        owner: &crate::ID,
    }
    .invoke_signed(&signer)?;

    // Write state
    let mut account_data = audit_record_account.try_borrow_mut()?;
    let record: &mut AuditRecord = bytemuck::from_bytes_mut(&mut account_data[..AuditRecord::LEN]);

    record.discriminator = AuditRecord::DISCRIMINATOR;
    record.wa_commitment = wa_commitment;

    log("Audit Record created");
    Ok(())
}

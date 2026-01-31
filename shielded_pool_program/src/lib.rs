#![no_std]

use pinocchio::{
    address::declare_id, entrypoint, error::ProgramError, AccountView, Address, ProgramResult,
};
use solana_program_log::log;

pub mod instructions;
pub mod state;

declare_id!("H76rmbsE6HxkDw7AWEJLtqYogyP6psq3Fk2wqPH7Cjes");

entrypoint!(process_instruction);

#[inline(always)]
fn process_instruction(
    _program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (ix_disc, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *ix_disc {
        instructions::instruction::INITIALIZE => {
            log("Instruction: Initialize");
            instructions::process_initialize(accounts, data)
        }
        instructions::instruction::DEPOSIT => {
            log("Instruction: Deposit");
            instructions::process_deposit(accounts, data)
        }
        instructions::instruction::WITHDRAW => {
            log("Instruction: Withdraw");
            instructions::process_withdraw(accounts, data)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

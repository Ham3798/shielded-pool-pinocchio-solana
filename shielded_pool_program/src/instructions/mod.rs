pub mod deposit;
pub mod initialize;
pub mod submit_audit;
pub mod withdraw;

pub mod instruction {
    pub const INITIALIZE: u8 = 0;
    pub const DEPOSIT: u8 = 1;
    pub const WITHDRAW: u8 = 2;
    pub const SUBMIT_AUDIT: u8 = 3;
}

pub use deposit::process_deposit;
pub use initialize::process_initialize;
pub use submit_audit::process_submit_audit;
pub use withdraw::process_withdraw;

#[path = "acp/authority.rs"]
mod implementation;

pub use implementation::{
    acquire_bootstrap_lease, with_bootstrap_lease, BootstrapLease, DbAuthority,
};

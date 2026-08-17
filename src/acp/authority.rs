//! Singleton authority for the ACP event-store database slot.
//!
//! The lock file for the logical slot and the lock file keyed by the opened
//! database identity are both held for the lifetime of an event store. The
//! first lock prevents path replacement from creating a second logical ACP
//! store, while the second lock prevents two aliases of the same file from
//! acquiring independent authority.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use fs2::FileExt;

/// A short-lived lease used while a process performs the pre-serve ACP
/// database rename or merge migration.
pub struct BootstrapLease {
    logical_path: PathBuf,
    _file: File,
}

impl BootstrapLease {
    pub fn logical_path(&self) -> &Path {
        &self.logical_path
    }
}

/// Acquire the logical database-slot lease without opening SQLite. This is
/// the lease used by v012 before it renames or merges the ACP database.
pub fn acquire_bootstrap_lease(db_path: &Path) -> Result<BootstrapLease> {
    let logical_path = normalize_logical_path(db_path)?;
    let lock_path = logical_path.with_file_name(format!(
        ".{}.authority.lock",
        logical_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("acp-events")
    ));
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .with_context(|| format!("open ACP authority lease {}", lock_path.display()))?;
    file.try_lock_exclusive().with_context(|| {
        format!(
            "acquire ACP logical database-slot lease for {}",
            logical_path.display()
        )
    })?;
    Ok(BootstrapLease {
        logical_path,
        _file: file,
    })
}

/// Run a short-lived bootstrap operation while holding the logical ACP slot
/// lease. The lease is deliberately not used by the external CLI purge,
/// which must remain compatible with a live daemon's SQLite connection.
pub fn with_bootstrap_lease<T, F>(db_path: &Path, operation: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let _lease = acquire_bootstrap_lease(db_path)?;
    operation()
}

/// The two leases and the opened-file identity retained by a daemon-owned
/// EventStore.
pub struct DbAuthority {
    logical_path: PathBuf,
    opened_identity: String,
    _opened_file: File,
    _identity_lease: File,
    _bootstrap_lease: BootstrapLease,
}

impl DbAuthority {
    /// Acquire both authority leases and create the target file if needed.
    /// No SQLite schema work is performed here.
    pub fn acquire(db_path: &Path) -> Result<Self> {
        let bootstrap_lease = acquire_bootstrap_lease(db_path)?;
        let logical_path = bootstrap_lease.logical_path().to_path_buf();
        let opened_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&logical_path)
            .with_context(|| format!("open ACP database slot {}", logical_path.display()))?;
        let opened_identity = file_identity(&opened_file)
            .with_context(|| format!("identify ACP database {}", logical_path.display()))?;

        // Keep identity locks in one deterministic namespace rather than
        // beside the logical path. Hardlink aliases can live in different
        // directories, so a sidecar next to each alias would not converge.
        let identity_lock_path = std::env::temp_dir().join(format!(
            ".aoe-acp-identity.{}.lock",
            safe_identity_name(&opened_identity)
        ));
        let identity_lease = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&identity_lock_path)
            .with_context(|| format!("open ACP identity lease {}", identity_lock_path.display()))?;
        identity_lease.try_lock_exclusive().with_context(|| {
            format!(
                "acquire ACP opened-file identity lease for {}",
                logical_path.display()
            )
        })?;

        let authority = Self {
            logical_path,
            opened_identity,
            _opened_file: opened_file,
            _identity_lease: identity_lease,
            _bootstrap_lease: bootstrap_lease,
        };
        authority.check_path_identity()?;
        Ok(authority)
    }

    /// Verify that the logical path still resolves to the file identity that
    /// was opened when authority was acquired. Callers use this at mutation
    /// boundaries and before exposing the writer.
    pub fn check_path_identity(&self) -> Result<()> {
        let current = fs::metadata(&self.logical_path).with_context(|| {
            format!(
                "stat ACP logical database slot {}",
                self.logical_path.display()
            )
        })?;
        let current_identity = file_identity_from_metadata(&current)?;
        if current_identity != self.opened_identity {
            bail!(
                "ACP database authority lost: {} now identifies as {}, expected {}",
                self.logical_path.display(),
                current_identity,
                self.opened_identity
            );
        }
        Ok(())
    }

    pub fn logical_path(&self) -> &Path {
        &self.logical_path
    }

    pub fn opened_identity(&self) -> &str {
        &self.opened_identity
    }
}

fn normalize_logical_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("resolve current directory for ACP database slot")?
            .join(path)
    };
    let parent = absolute
        .parent()
        .ok_or_else(|| anyhow::anyhow!("ACP database path has no parent"))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create ACP database parent {}", parent.display()))?;
    let parent = fs::canonicalize(parent)
        .with_context(|| format!("canonicalize ACP database parent {}", parent.display()))?;
    let file_name = absolute
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("ACP database path has no file name"))?;
    let candidate = parent.join(file_name);
    if candidate.exists() {
        fs::canonicalize(&candidate)
            .with_context(|| format!("canonicalize ACP database path {}", candidate.display()))
    } else {
        Ok(candidate)
    }
}

fn file_identity(file: &File) -> Result<String> {
    let metadata = file.metadata().context("read ACP database file metadata")?;
    file_identity_from_metadata(&metadata)
}

#[cfg(unix)]
fn file_identity_from_metadata(metadata: &fs::Metadata) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity_from_metadata(metadata: &fs::Metadata) -> Result<String> {
    use std::os::windows::fs::MetadataExt;
    let volume = metadata
        .volume_serial_number()
        .ok_or_else(|| anyhow::anyhow!("ACP database volume identity is unavailable"))?;
    let index = metadata
        .file_index()
        .ok_or_else(|| anyhow::anyhow!("ACP database file identity is unavailable"))?;
    Ok(format!("{}:{}", volume, index))
}

#[cfg(not(any(unix, windows)))]
fn file_identity_from_metadata(_metadata: &fs::Metadata) -> Result<String> {
    bail!("ACP database authority has no safe file-identity primitive on this platform")
}

fn safe_identity_name(identity: &str) -> String {
    identity
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_slot_lease_is_singleton_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acp_events.db");
        let lease = acquire_bootstrap_lease(&path).unwrap();
        assert!(acquire_bootstrap_lease(&path).is_err());
        drop(lease);
        assert!(acquire_bootstrap_lease(&path).is_ok());
    }

    #[test]
    fn path_replacement_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acp_events.db");
        let authority = DbAuthority::acquire(&path).unwrap();
        let replacement = dir.path().join("replacement.db");
        fs::write(&replacement, b"replacement").unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert!(authority.check_path_identity().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn hardlink_aliases_share_the_opened_identity_lease() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acp_events.db");
        let alias_dir = dir.path().join("alias");
        fs::create_dir(&alias_dir).unwrap();
        let alias = alias_dir.join("acp_events.db");
        let authority = DbAuthority::acquire(&path).unwrap();
        fs::hard_link(&path, &alias).unwrap();
        assert!(DbAuthority::acquire(&alias).is_err());
        drop(authority);
        assert!(DbAuthority::acquire(&alias).is_ok());
    }

    #[test]
    fn first_create_race_allows_only_one_live_authority() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acp_events.db");
        let start = std::sync::Arc::new(std::sync::Barrier::new(2));
        let finish = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let start = std::sync::Arc::clone(&start);
                let finish = std::sync::Arc::clone(&finish);
                let path = path.clone();
                std::thread::spawn(move || {
                    start.wait();
                    let authority = DbAuthority::acquire(&path);
                    let acquired = authority.is_ok();
                    // Keep the successful lease live until both contenders
                    // have crossed the acquisition point.
                    finish.wait();
                    drop(authority);
                    acquired
                })
            })
            .collect::<Vec<_>>();
        let acquired = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|acquired| *acquired)
            .count();
        assert_eq!(acquired, 1);
    }
}

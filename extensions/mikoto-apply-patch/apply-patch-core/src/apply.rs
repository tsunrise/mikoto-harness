use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::diff::{FileContentChange, build_changes};
use crate::error::{ApplyPatchError, ApplyPatchFailure};
use crate::file_update::derive_new_contents;
use crate::filesystem::{FileSystem, OsFileSystem};
use crate::model::{
  ApplyPatchChange, ApplyPatchChangeKind, ApplyPatchOutcome, CancellationFlag, Hunk, PreparedPatch,
};
use crate::path_resolution::absolute_lexical_path;
use crate::virtual_filesystem::VirtualFileSystem;

#[derive(Debug)]
pub(crate) struct PatchFsUpdate {
  steps: Vec<FsUpdateStep>,
}

#[derive(Debug)]
struct FsUpdateStep {
  operation: FsOperation,
  change: ApplyPatchChange,
}

#[derive(Debug)]
enum FsOperation {
  Write {
    path: PathBuf,
    content: Arc<str>,
    create_parents: bool,
  },
  Delete {
    path: PathBuf,
  },
  Move {
    source: PathBuf,
    destination: PathBuf,
    content: Arc<str>,
  },
}

pub fn apply_patch(
  prepared: PreparedPatch,
  cancellation: &CancellationFlag,
) -> Result<ApplyPatchOutcome, ApplyPatchFailure> {
  apply_patch_with_filesystem(prepared, cancellation, &OsFileSystem)
}

pub(crate) fn apply_patch_with_filesystem(
  prepared: PreparedPatch,
  cancellation: &CancellationFlag,
  filesystem: &dyn FileSystem,
) -> Result<ApplyPatchOutcome, ApplyPatchFailure> {
  prepared
    .plan_fs_update(cancellation, filesystem)
    .map_err(ApplyPatchFailure::before_commit)?
    .commit(filesystem)
}

impl PreparedPatch {
  pub(crate) fn plan_fs_update(
    self,
    cancellation: &CancellationFlag,
    filesystem: &dyn FileSystem,
  ) -> Result<PatchFsUpdate, ApplyPatchError> {
    check_cancelled(cancellation)?;

    let resolved_target_by_lexical = self
      .pinned_resolved_paths
      .iter()
      .map(|pinned_path| {
        (
          pinned_path.lexical.clone(),
          pinned_path.resolved_target.clone(),
        )
      })
      .collect::<HashMap<_, _>>();
    let mut virtual_filesystem = VirtualFileSystem::new(filesystem);
    let mut operations = Vec::with_capacity(self.hunks.len());
    let mut changes = Vec::with_capacity(self.hunks.len());

    for hunk in self.hunks {
      check_cancelled(cancellation)?;
      match hunk {
        Hunk::AddFile { path, contents } => {
          let lexical = absolute_lexical_path(&self.root, &path);
          let resolved_target = resolved_target_for(&lexical, &resolved_target_by_lexical)?;
          let old_content = match virtual_filesystem.read_to_string(&resolved_target) {
            Ok(contents) => Some(contents),
            Err(source) if source.kind() == io::ErrorKind::NotFound => None,
            Err(source) => return Err(destination_read_error(&resolved_target, source)),
          };
          let new_content = Arc::<str>::from(contents);
          let operation = FsOperation::Write {
            path: resolved_target,
            content: new_content.clone(),
            create_parents: true,
          };
          operation.simulate(&mut virtual_filesystem)?;
          operations.push(operation);
          changes.push(FileContentChange {
            kind: ApplyPatchChangeKind::Added,
            path: display_path(&self.root, &lexical),
            move_path: None,
            old_content,
            new_content: Some(new_content),
          });
        }
        Hunk::DeleteFile { path } => {
          let lexical = absolute_lexical_path(&self.root, &path);
          let resolved_target = resolved_target_for(&lexical, &resolved_target_by_lexical)?;
          let old_content = virtual_filesystem
            .read_to_string(&resolved_target)
            .map_err(|source| {
              source_file_read_error(
                &resolved_target,
                "delete requires an existing regular file",
                source,
              )
            })?;
          let operation = FsOperation::Delete {
            path: resolved_target,
          };
          operation.simulate(&mut virtual_filesystem)?;
          operations.push(operation);
          changes.push(FileContentChange {
            kind: ApplyPatchChangeKind::Deleted,
            path: display_path(&self.root, &lexical),
            move_path: None,
            old_content: Some(old_content),
            new_content: None,
          });
        }
        Hunk::UpdateFile {
          path,
          move_path,
          chunks,
        } => {
          let lexical = absolute_lexical_path(&self.root, &path);
          let resolved_target = resolved_target_for(&lexical, &resolved_target_by_lexical)?;
          let old_content = virtual_filesystem
            .read_to_string(&resolved_target)
            .map_err(|source| {
              source_file_read_error(
                &resolved_target,
                "update requires an existing regular file",
                source,
              )
            })?;
          let new_content = Arc::<str>::from(derive_new_contents(
            &resolved_target,
            old_content.as_ref(),
            &chunks,
          )?);

          if let Some(move_path) = move_path {
            let move_lexical = absolute_lexical_path(&self.root, &move_path);
            let destination = resolved_target_for(&move_lexical, &resolved_target_by_lexical)?;

            let operation = FsOperation::Move {
              source: resolved_target,
              destination,
              content: new_content.clone(),
            };
            operation.simulate(&mut virtual_filesystem)?;
            operations.push(operation);
            changes.push(FileContentChange {
              kind: ApplyPatchChangeKind::Modified,
              path: display_path(&self.root, &lexical),
              move_path: Some(display_path(&self.root, &move_lexical)),
              old_content: Some(old_content),
              new_content: Some(new_content),
            });
          } else {
            let operation = FsOperation::Write {
              path: resolved_target,
              content: new_content.clone(),
              create_parents: false,
            };
            operation.simulate(&mut virtual_filesystem)?;
            operations.push(operation);
            changes.push(FileContentChange {
              kind: ApplyPatchChangeKind::Modified,
              path: display_path(&self.root, &lexical),
              move_path: None,
              old_content: Some(old_content),
              new_content: Some(new_content),
            });
          }
        }
      }
    }

    let changes = build_changes(changes);
    check_cancelled(cancellation)?;
    Ok(PatchFsUpdate::new(operations, changes))
  }
}

impl PatchFsUpdate {
  fn new(operations: Vec<FsOperation>, changes: Vec<ApplyPatchChange>) -> Self {
    assert_eq!(
      operations.len(),
      changes.len(),
      "every filesystem operation must have one outcome change"
    );
    let steps = operations
      .into_iter()
      .zip(changes)
      .map(|(operation, change)| FsUpdateStep { operation, change })
      .collect();
    Self { steps }
  }

  pub(crate) fn commit(
    self,
    filesystem: &dyn FileSystem,
  ) -> Result<ApplyPatchOutcome, ApplyPatchFailure> {
    let Self { steps } = self;
    let mut committed = Vec::with_capacity(steps.len());

    for step in steps {
      if let Err(error) = step.operation.commit(filesystem) {
        return Err(ApplyPatchFailure::new(
          error,
          committed,
          step.operation.affected_paths(),
        ));
      }
      committed.push(step.change);
    }

    Ok(ApplyPatchOutcome { changes: committed })
  }
}

fn resolved_target_for(
  lexical: &Path,
  resolved_target_by_lexical: &HashMap<PathBuf, PathBuf>,
) -> Result<PathBuf, ApplyPatchError> {
  resolved_target_by_lexical
    .get(lexical)
    .cloned()
    .ok_or_else(|| ApplyPatchError::preflight(lexical, "pinned resolved path is missing"))
}

fn destination_read_error(path: &Path, source: io::Error) -> ApplyPatchError {
  match source.kind() {
    io::ErrorKind::IsADirectory => ApplyPatchError::preflight(path, "destination is a directory"),
    io::ErrorKind::InvalidInput => {
      ApplyPatchError::preflight(path, "destination is not a regular file")
    }
    io::ErrorKind::NotADirectory | io::ErrorKind::AlreadyExists => {
      ApplyPatchError::preflight(path, source.to_string())
    }
    _ => ApplyPatchError::io("inspect destination", path, source),
  }
}

fn source_file_read_error(
  path: &Path,
  missing_message: &str,
  source: io::Error,
) -> ApplyPatchError {
  match source.kind() {
    io::ErrorKind::NotFound => ApplyPatchError::preflight(path, missing_message),
    io::ErrorKind::IsADirectory => ApplyPatchError::preflight(path, "path is a directory"),
    io::ErrorKind::InvalidInput => ApplyPatchError::preflight(path, "path is not a regular file"),
    io::ErrorKind::NotADirectory | io::ErrorKind::AlreadyExists => {
      ApplyPatchError::preflight(path, source.to_string())
    }
    _ => ApplyPatchError::io("read", path, source),
  }
}

fn simulation_error(action: &'static str, path: &Path, source: io::Error) -> ApplyPatchError {
  match source.kind() {
    io::ErrorKind::NotFound
    | io::ErrorKind::AlreadyExists
    | io::ErrorKind::InvalidInput
    | io::ErrorKind::IsADirectory
    | io::ErrorKind::NotADirectory => ApplyPatchError::preflight(path, source.to_string()),
    _ => ApplyPatchError::io(action, path, source),
  }
}

impl FsOperation {
  /// Apply this commit operation only to the planning overlay.
  ///
  /// Keeping simulation beside `commit` makes details such as Add creating
  /// parents and Move writing before deleting visible in one place. However,
  /// the overlay remains state rather than a journal: we retain this operation
  /// separately so a successful plan can later commit one logical hunk at a
  /// time.
  fn simulate(&self, filesystem: &mut VirtualFileSystem<'_>) -> Result<(), ApplyPatchError> {
    match self {
      Self::Write {
        path,
        content,
        create_parents,
      } => {
        if *create_parents {
          create_virtual_parent(path, filesystem)?;
        }
        filesystem
          .write(path, content.clone())
          .map_err(|source| simulation_error("plan write", path, source))
      }
      Self::Delete { path } => filesystem
        .remove_file(path)
        .map_err(|source| simulation_error("plan delete", path, source)),
      Self::Move {
        source,
        destination,
        content,
      } => {
        create_virtual_parent(destination, filesystem)?;
        filesystem
          .write(destination, content.clone())
          .map_err(|source| simulation_error("plan move destination", destination, source))?;
        if source != destination {
          filesystem
            .remove_file(source)
            .map_err(|source_error| simulation_error("plan move source", source, source_error))?;
        }
        Ok(())
      }
    }
  }

  fn commit(&self, filesystem: &dyn FileSystem) -> Result<(), ApplyPatchError> {
    match self {
      Self::Write {
        path,
        content,
        create_parents,
      } => {
        if *create_parents {
          create_parent(path, filesystem)?;
        }
        filesystem
          .write(path, content.as_bytes())
          .map_err(|source| ApplyPatchError::io("write", path, source))
      }
      Self::Delete { path } => filesystem
        .remove_file(path)
        .map_err(|source| ApplyPatchError::io("delete", path, source)),
      Self::Move {
        source,
        destination,
        content,
      } => {
        create_parent(destination, filesystem)?;
        filesystem
          .write(destination, content.as_bytes())
          .map_err(|source| ApplyPatchError::io("write move destination", destination, source))?;
        if source != destination {
          filesystem.remove_file(source).map_err(|source_error| {
            ApplyPatchError::io("remove move source", source, source_error)
          })?;
        }
        Ok(())
      }
    }
  }

  fn affected_paths(&self) -> Vec<PathBuf> {
    match self {
      Self::Write { path, .. } | Self::Delete { path } => vec![path.clone()],
      Self::Move {
        source,
        destination,
        ..
      } => vec![source.clone(), destination.clone()],
    }
  }
}

fn create_virtual_parent(
  path: &Path,
  filesystem: &mut VirtualFileSystem<'_>,
) -> Result<(), ApplyPatchError> {
  if let Some(parent) = path.parent() {
    filesystem
      .create_dir_all(parent)
      .map_err(|source| simulation_error("plan parent directories for", path, source))?;
  }
  Ok(())
}

fn create_parent(path: &Path, filesystem: &dyn FileSystem) -> Result<(), ApplyPatchError> {
  if let Some(parent) = path.parent() {
    filesystem
      .create_dir_all(parent)
      .map_err(|source| ApplyPatchError::io("create parent directories for", path, source))?;
  }
  Ok(())
}

fn display_path(root: &Path, lexical: &Path) -> String {
  lexical
    .strip_prefix(root)
    .ok()
    .filter(|relative| !relative.as_os_str().is_empty())
    .unwrap_or(lexical)
    .to_string_lossy()
    .into_owned()
}

fn check_cancelled(cancellation: &CancellationFlag) -> Result<(), ApplyPatchError> {
  if cancellation.is_cancelled() {
    Err(ApplyPatchError::Cancelled)
  } else {
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use std::collections::BTreeMap;
  use std::io;
  use std::sync::atomic::{AtomicUsize, Ordering};

  use super::*;
  use crate::filesystem::{OsFileSystem, PathKind};
  use crate::prepare::prepare_patch;

  #[test]
  fn planning_failure_leaves_every_file_unchanged() {
    let temp = tempfile::tempdir().unwrap();
    let patch = r#"*** Begin Patch
*** Add File: created.txt
+created
*** Update File: missing.txt
@@
-old
+new
*** End Patch"#;
    let prepared = prepare_patch(temp.path(), patch).unwrap();

    let error = apply_patch(prepared, &CancellationFlag::new()).unwrap_err();
    assert!(error.committed().is_empty());
    assert!(!temp.path().join("created.txt").exists());
  }

  #[test]
  fn applies_add_update_move_and_delete_with_a_virtual_filesystem() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("update.txt"), "old\n").unwrap();
    std::fs::write(temp.path().join("delete.txt"), "gone\n").unwrap();
    let patch = r#"*** Begin Patch
*** Add File: nested/new.txt
+first
*** Update File: nested/new.txt
@@
-first
+second
*** Update File: update.txt
*** Move to: moved.txt
@@
-old
+changed
*** Delete File: delete.txt
*** End Patch"#;

    let prepared = prepare_patch(temp.path(), patch).unwrap();
    let outcome = apply_patch(prepared, &CancellationFlag::new()).unwrap();

    assert_eq!(
      std::fs::read_to_string(temp.path().join("nested/new.txt")).unwrap(),
      "second\n"
    );
    assert!(!temp.path().join("update.txt").exists());
    assert_eq!(
      std::fs::read_to_string(temp.path().join("moved.txt")).unwrap(),
      "changed\n"
    );
    assert!(!temp.path().join("delete.txt").exists());
    assert_eq!(outcome.changes.len(), 4);
    assert_eq!(outcome.changes[2].diff, "-1 old\n+1 changed");
  }

  #[test]
  fn rejects_a_file_replacing_an_implied_virtual_parent_before_commit() {
    let temp = tempfile::tempdir().unwrap();
    let prepared = prepare_patch(
      temp.path(),
      concat!(
        "*** Begin Patch\n",
        "*** Add File: nested/child.txt\n",
        "+child\n",
        "*** Add File: nested\n",
        "+file\n",
        "*** End Patch",
      ),
    )
    .unwrap();

    let error = apply_patch(prepared, &CancellationFlag::new()).unwrap_err();

    assert!(matches!(error.error(), ApplyPatchError::Preflight { .. }));
    assert!(error.committed().is_empty());
    assert!(!temp.path().join("nested").exists());
  }

  #[test]
  fn returns_an_empty_display_diff_for_a_move_without_text_changes() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("old.txt"), "same\n").unwrap();
    let prepared = prepare_patch(
      temp.path(),
      concat!(
        "*** Begin Patch\n",
        "*** Update File: old.txt\n",
        "*** Move to: moved.txt\n",
        "@@\n",
        "-same\n",
        "+same\n",
        "*** End Patch",
      ),
    )
    .unwrap();

    let outcome = apply_patch(prepared, &CancellationFlag::new()).unwrap();

    assert!(!temp.path().join("old.txt").exists());
    assert_eq!(
      std::fs::read_to_string(temp.path().join("moved.txt")).unwrap(),
      "same\n"
    );
    assert_eq!(outcome.changes.len(), 1);
    assert_eq!(outcome.changes[0].move_path.as_deref(), Some("moved.txt"));
    assert!(outcome.changes[0].diff.is_empty());
  }

  #[test]
  fn rejects_cancelled_patch_before_commit() {
    let temp = tempfile::tempdir().unwrap();
    let prepared = prepare_patch(
      temp.path(),
      "*** Begin Patch\n*** Add File: x\n+x\n*** End Patch",
    )
    .unwrap();
    let cancellation = CancellationFlag::new();
    cancellation.cancel();

    let error = apply_patch(prepared, &cancellation).unwrap_err();
    assert!(matches!(error.error(), ApplyPatchError::Cancelled));
    assert!(!temp.path().join("x").exists());
  }

  #[cfg(unix)]
  #[test]
  fn ignores_changed_lexical_alias_and_uses_the_pinned_target() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    std::fs::write(first.join("file.txt"), "old\n").unwrap();
    std::fs::write(second.join("file.txt"), "old\n").unwrap();
    symlink(&first, root.join("link")).unwrap();

    let prepared = prepare_patch(
      &root,
      "*** Begin Patch\n*** Update File: link/file.txt\n@@\n-old\n+new\n*** End Patch",
    )
    .unwrap();
    assert_eq!(
      prepared
        .targets()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>(),
      vec![std::fs::canonicalize(first.join("file.txt")).unwrap()]
    );
    std::fs::remove_file(root.join("link")).unwrap();
    symlink(&second, root.join("link")).unwrap();

    apply_patch(prepared, &CancellationFlag::new()).unwrap();
    assert_eq!(
      std::fs::read_to_string(first.join("file.txt")).unwrap(),
      "new\n"
    );
    assert_eq!(
      std::fs::read_to_string(second.join("file.txt")).unwrap(),
      "old\n"
    );
  }

  #[cfg(unix)]
  #[test]
  fn rejects_symlinks_introduced_into_a_pinned_resolved_path() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(root.join("file.txt"), "old\n").unwrap();
    std::fs::write(outside.join("victim.txt"), "outside\n").unwrap();

    let update = prepare_patch(
      &root,
      "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End Patch",
    )
    .unwrap();
    std::fs::remove_file(root.join("file.txt")).unwrap();
    symlink(outside.join("victim.txt"), root.join("file.txt")).unwrap();

    apply_patch(update, &CancellationFlag::new()).unwrap_err();
    assert_eq!(
      std::fs::read_to_string(outside.join("victim.txt")).unwrap(),
      "outside\n"
    );

    let add = prepare_patch(
      &root,
      "*** Begin Patch\n*** Add File: nested/new.txt\n+new\n*** End Patch",
    )
    .unwrap();
    symlink(&outside, root.join("nested")).unwrap();

    apply_patch(add, &CancellationFlag::new()).unwrap_err();
    assert!(!outside.join("new.txt").exists());
  }

  #[cfg(unix)]
  #[test]
  fn commits_to_the_prepared_canonical_target() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    symlink(&outside, root.join("link")).unwrap();

    let prepared = prepare_patch(
      &root,
      "*** Begin Patch\n*** Add File: link/file.txt\n+outside\n*** End Patch",
    )
    .unwrap();
    apply_patch(prepared, &CancellationFlag::new()).unwrap();

    assert_eq!(
      std::fs::read_to_string(outside.join("file.txt")).unwrap(),
      "outside\n"
    );
    assert!(
      root
        .join("link")
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink()
    );
  }

  struct FailingFileSystem {
    writes: AtomicUsize,
    fail_write: usize,
  }

  impl FileSystem for FailingFileSystem {
    fn lexical_entry_kind(&self, lexical_path: &Path) -> io::Result<PathKind> {
      OsFileSystem.lexical_entry_kind(lexical_path)
    }

    fn canonical_entry_kind(&self, canonical_path: &Path) -> io::Result<PathKind> {
      OsFileSystem.canonical_entry_kind(canonical_path)
    }

    fn canonicalize(&self, lexical_path: &Path) -> io::Result<PathBuf> {
      OsFileSystem.canonicalize(lexical_path)
    }

    fn read_link(&self, lexical_path: &Path) -> io::Result<PathBuf> {
      OsFileSystem.read_link(lexical_path)
    }

    fn read_to_string(&self, canonical_path: &Path) -> io::Result<String> {
      OsFileSystem.read_to_string(canonical_path)
    }

    fn create_dir_all(&self, canonical_path: &Path) -> io::Result<()> {
      OsFileSystem.create_dir_all(canonical_path)
    }

    fn write(&self, canonical_path: &Path, contents: &[u8]) -> io::Result<()> {
      let write = self.writes.fetch_add(1, Ordering::SeqCst);
      if write == self.fail_write {
        Err(io::Error::other("injected write failure"))
      } else {
        OsFileSystem.write(canonical_path, contents)
      }
    }

    fn remove_file(&self, canonical_path: &Path) -> io::Result<()> {
      OsFileSystem.remove_file(canonical_path)
    }
  }

  #[test]
  fn reports_committed_prefix_on_commit_failure() {
    let temp = tempfile::tempdir().unwrap();
    let prepared = prepare_patch(
      temp.path(),
      "*** Begin Patch\n*** Add File: first\n+one\n*** Add File: second\n+two\n*** End Patch",
    )
    .unwrap();
    let filesystem = FailingFileSystem {
      writes: AtomicUsize::new(0),
      fail_write: 1,
    };

    let error =
      apply_patch_with_filesystem(prepared, &CancellationFlag::new(), &filesystem).unwrap_err();
    assert_eq!(error.committed().len(), 1);
    assert_eq!(error.committed()[0].path, "first");
    assert!(temp.path().join("first").exists());
    assert!(!temp.path().join("second").exists());
    assert!(error.to_string().contains("committed patch prefix: first"));
  }

  struct CancelOnFirstWriteFileSystem {
    writes: AtomicUsize,
    cancellation: CancellationFlag,
  }

  impl FileSystem for CancelOnFirstWriteFileSystem {
    fn lexical_entry_kind(&self, lexical_path: &Path) -> io::Result<PathKind> {
      OsFileSystem.lexical_entry_kind(lexical_path)
    }

    fn canonical_entry_kind(&self, canonical_path: &Path) -> io::Result<PathKind> {
      OsFileSystem.canonical_entry_kind(canonical_path)
    }

    fn canonicalize(&self, lexical_path: &Path) -> io::Result<PathBuf> {
      OsFileSystem.canonicalize(lexical_path)
    }

    fn read_link(&self, lexical_path: &Path) -> io::Result<PathBuf> {
      OsFileSystem.read_link(lexical_path)
    }

    fn read_to_string(&self, canonical_path: &Path) -> io::Result<String> {
      OsFileSystem.read_to_string(canonical_path)
    }

    fn create_dir_all(&self, canonical_path: &Path) -> io::Result<()> {
      OsFileSystem.create_dir_all(canonical_path)
    }

    fn write(&self, canonical_path: &Path, contents: &[u8]) -> io::Result<()> {
      let result = OsFileSystem.write(canonical_path, contents);
      if self.writes.fetch_add(1, Ordering::SeqCst) == 0 {
        self.cancellation.cancel();
      }
      result
    }

    fn remove_file(&self, canonical_path: &Path) -> io::Result<()> {
      OsFileSystem.remove_file(canonical_path)
    }
  }

  #[test]
  fn cancellation_after_commit_starts_does_not_interrupt_the_patch() {
    let temp = tempfile::tempdir().unwrap();
    let prepared = prepare_patch(
      temp.path(),
      "*** Begin Patch\n*** Add File: first\n+one\n*** Add File: second\n+two\n*** End Patch",
    )
    .unwrap();
    let cancellation = CancellationFlag::new();
    let filesystem = CancelOnFirstWriteFileSystem {
      writes: AtomicUsize::new(0),
      cancellation: cancellation.clone(),
    };

    let outcome = apply_patch_with_filesystem(prepared, &cancellation, &filesystem).unwrap();
    assert_eq!(outcome.changes.len(), 2);
    assert!(cancellation.is_cancelled());
    assert_eq!(
      std::fs::read_to_string(temp.path().join("first")).unwrap(),
      "one\n"
    );
    assert_eq!(
      std::fs::read_to_string(temp.path().join("second")).unwrap(),
      "two\n"
    );
  }

  #[test]
  fn runs_portable_scenario_fixtures() {
    const EXPECTED_SCENARIOS: &[&str] = &[
      "001_add_file",
      "002_multiple_operations",
      "003_multiple_chunks",
      "004_move_to_new_directory",
      "005_rejects_empty_patch",
      "006_rejects_missing_context",
      "007_rejects_missing_file_delete",
      "008_rejects_empty_update_hunk",
      "009_requires_existing_file_for_update",
      "010_move_overwrites_existing_destination",
      "011_add_overwrites_existing_file",
      "012_delete_directory_fails",
      "013_rejects_invalid_hunk_header",
      "014_update_file_appends_trailing_newline",
      "015_failure_after_partial_success_leaves_changes",
      "016_pure_addition_update_chunk",
      "017_whitespace_padded_hunk_header",
      "018_whitespace_padded_patch_markers",
      "019_unicode_simple",
      "020_delete_file_success",
      "020_whitespace_padded_patch_marker_lines",
      "021_update_file_deletion_only",
      "022_update_file_end_of_file_marker",
      "023_preserves_crlf_line_endings",
      "024_preserves_mixed_line_endings",
    ];
    const EXPECTED_FAILURES: &[&str] = &[
      "005_rejects_empty_patch",
      "006_rejects_missing_context",
      "007_rejects_missing_file_delete",
      "008_rejects_empty_update_hunk",
      "009_requires_existing_file_for_update",
      "012_delete_directory_fails",
      "013_rejects_invalid_hunk_header",
      "015_failure_after_partial_success_leaves_changes",
    ];

    let scenarios = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/scenarios");
    let mut entries = std::fs::read_dir(&scenarios)
      .unwrap()
      .collect::<Result<Vec<_>, _>>()
      .unwrap();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    let scenario_names = entries
      .iter()
      .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_dir()))
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .collect::<Vec<_>>();
    assert_eq!(
      scenario_names,
      EXPECTED_SCENARIOS
        .iter()
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>()
    );

    for entry in entries {
      if !entry.file_type().unwrap().is_dir() {
        continue;
      }
      let scenario = entry.path();
      let workspace = tempfile::tempdir().unwrap();
      let input = scenario.join("input");
      if input.is_dir() {
        copy_directory(&input, workspace.path()).unwrap();
      }

      let patch = std::fs::read_to_string(scenario.join("patch.txt")).unwrap();
      let succeeded = prepare_patch(workspace.path(), &patch)
        .is_ok_and(|prepared| apply_patch(prepared, &CancellationFlag::new()).is_ok());
      let scenario_name = entry.file_name();
      let expects_failure = EXPECTED_FAILURES.contains(&scenario_name.to_string_lossy().as_ref());
      assert_eq!(
        succeeded,
        !expects_failure,
        "scenario {} returned an unexpected status",
        scenario.display()
      );

      assert_eq!(
        snapshot_directory(workspace.path()).unwrap(),
        snapshot_directory(&scenario.join("expected")).unwrap(),
        "scenario {} did not match its expected state",
        scenario.display()
      );
    }
  }

  fn copy_directory(source: &Path, destination: &Path) -> io::Result<()> {
    for entry in std::fs::read_dir(source)? {
      let entry = entry?;
      let source_path = entry.path();
      let destination_path = destination.join(entry.file_name());
      if entry.file_type()?.is_dir() {
        std::fs::create_dir_all(&destination_path)?;
        copy_directory(&source_path, &destination_path)?;
      } else if source_path
        .extension()
        .is_some_and(|extension| extension == "hex")
      {
        let destination_path = destination_path.with_extension("");
        let contents = decode_hex(&std::fs::read_to_string(source_path)?)?;
        std::fs::write(destination_path, contents)?;
      } else {
        if let Some(parent) = destination_path.parent() {
          std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(source_path, destination_path)?;
      }
    }
    Ok(())
  }

  fn snapshot_directory(root: &Path) -> io::Result<BTreeMap<PathBuf, Vec<u8>>> {
    fn visit(
      root: &Path,
      directory: &Path,
      snapshot: &mut BTreeMap<PathBuf, Vec<u8>>,
    ) -> io::Result<()> {
      if !directory.is_dir() {
        return Ok(());
      }
      for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
          visit(root, &path, snapshot)?;
        } else {
          let relative = path.strip_prefix(root).unwrap();
          if path.extension().is_some_and(|extension| extension == "hex") {
            snapshot.insert(
              relative.with_extension(""),
              decode_hex(&std::fs::read_to_string(path)?)?,
            );
            continue;
          }
          snapshot.insert(relative.to_path_buf(), std::fs::read(path)?);
        }
      }
      Ok(())
    }

    let mut snapshot = BTreeMap::new();
    visit(root, root, &mut snapshot)?;
    Ok(snapshot)
  }

  fn decode_hex(encoded: &str) -> io::Result<Vec<u8>> {
    let encoded = encoded.trim();
    if !encoded.len().is_multiple_of(2) {
      return Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "hex fixture has an odd number of digits",
      ));
    }

    let bytes = encoded.as_bytes();
    (0..bytes.len())
      .step_by(2)
      .map(|index| {
        let pair = &bytes[index..index + 2];
        let pair = std::str::from_utf8(pair)
          .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        u8::from_str_radix(pair, 16)
          .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
      })
      .collect()
  }
}

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::error::ApplyPatchError;
use crate::filesystem::{FileSystem, OsFileSystem};
use crate::model::{Hunk, PinnedResolvedPath, PreparedPatch};
use crate::parser::parse_patch;
use crate::path_resolution::{normalize_root, resolve_patch_path};

pub fn prepare_patch(root: &Path, patch: &str) -> Result<PreparedPatch, ApplyPatchError> {
  prepare_patch_with_filesystem(root, patch, &OsFileSystem)
}

pub(crate) fn prepare_patch_with_filesystem(
  root: &Path,
  patch: &str,
  filesystem: &dyn FileSystem,
) -> Result<PreparedPatch, ApplyPatchError> {
  let root = normalize_root(root)?;
  let parsed = parse_patch(patch)?;
  if parsed.hunks.is_empty() {
    return Err(ApplyPatchError::EmptyPatch);
  }

  let mut pinned_resolved_paths = BTreeMap::<PathBuf, PinnedResolvedPath>::new();
  for hunk in &parsed.hunks {
    match hunk {
      Hunk::AddFile { path, .. } | Hunk::DeleteFile { path } => {
        insert_pinned_path(&root, path, filesystem, &mut pinned_resolved_paths)?;
      }
      Hunk::UpdateFile {
        path, move_path, ..
      } => {
        insert_pinned_path(&root, path, filesystem, &mut pinned_resolved_paths)?;
        if let Some(move_path) = move_path {
          insert_pinned_path(&root, move_path, filesystem, &mut pinned_resolved_paths)?;
        }
      }
    }
  }

  let pinned_resolved_paths = pinned_resolved_paths.into_values().collect();
  Ok(PreparedPatch {
    root,
    hunks: parsed.hunks,
    pinned_resolved_paths,
  })
}

fn insert_pinned_path(
  root: &Path,
  path: &Path,
  filesystem: &dyn FileSystem,
  pinned_resolved_paths: &mut BTreeMap<PathBuf, PinnedResolvedPath>,
) -> Result<(), ApplyPatchError> {
  let pinned_path = resolve_patch_path(root, path, filesystem)?;
  pinned_resolved_paths
    .entry(pinned_path.lexical.clone())
    .or_insert(pinned_path);
  Ok(())
}

#[cfg(test)]
mod tests {
  use std::io;
  use std::sync::atomic::{AtomicUsize, Ordering};

  use super::*;
  use crate::filesystem::{OsFileSystem, PathKind};

  struct CountingFileSystem {
    reads: AtomicUsize,
  }

  impl FileSystem for CountingFileSystem {
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
      self.reads.fetch_add(1, Ordering::Relaxed);
      OsFileSystem.read_to_string(canonical_path)
    }

    fn create_dir_all(&self, canonical_path: &Path) -> io::Result<()> {
      OsFileSystem.create_dir_all(canonical_path)
    }

    fn write(&self, canonical_path: &Path, contents: &[u8]) -> io::Result<()> {
      OsFileSystem.write(canonical_path, contents)
    }

    fn remove_file(&self, canonical_path: &Path) -> io::Result<()> {
      OsFileSystem.remove_file(canonical_path)
    }
  }

  #[test]
  fn reports_sorted_deduplicated_source_and_move_targets_without_reads() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("z.txt"), "old\n").unwrap();
    let filesystem = CountingFileSystem {
      reads: AtomicUsize::new(0),
    };
    let patch = r#"*** Begin Patch
*** Update File: z.txt
*** Move to: a.txt
@@
-old
+new
*** Delete File: z.txt
*** End Patch"#;

    let prepared = prepare_patch_with_filesystem(temp.path(), patch, &filesystem).unwrap();
    let resolved_root = std::fs::canonicalize(temp.path()).unwrap();
    assert_eq!(
      prepared
        .targets()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>(),
      vec![resolved_root.join("a.txt"), resolved_root.join("z.txt")]
    );
    assert_eq!(filesystem.reads.load(Ordering::Relaxed), 0);
  }

  #[test]
  fn accepts_absolute_paths_outside_root() {
    let root = tempfile::tempdir().unwrap();
    let outside_directory = tempfile::tempdir().unwrap();
    let outside = outside_directory.path().join("outside.txt");
    let patch = format!(
      "*** Begin Patch\n*** Add File: {}\n+hello\n*** End Patch",
      outside.display()
    );
    let prepared = prepare_patch(root.path(), &patch).unwrap();
    assert_eq!(
      prepared
        .targets()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>(),
      vec![
        std::fs::canonicalize(outside_directory.path())
          .unwrap()
          .join("outside.txt")
      ]
    );
  }

  #[cfg(unix)]
  #[test]
  fn reports_deduplicated_resolved_policy_targets_for_aliases() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file.txt"), "old\n").unwrap();
    symlink(root.path().join("file.txt"), root.path().join("alias.txt")).unwrap();
    let patch = concat!(
      "*** Begin Patch\n",
      "*** Update File: file.txt\n",
      "@@\n",
      "-old\n",
      "+first\n",
      "*** Update File: alias.txt\n",
      "@@\n",
      "-first\n",
      "+second\n",
      "*** End Patch",
    );

    let prepared = prepare_patch(root.path(), patch).unwrap();

    assert_eq!(
      prepared
        .targets()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>(),
      vec![std::fs::canonicalize(root.path().join("file.txt")).unwrap()]
    );
  }
}

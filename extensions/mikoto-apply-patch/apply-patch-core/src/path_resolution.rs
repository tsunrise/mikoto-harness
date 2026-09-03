use std::io;
use std::path::{Component, Path, PathBuf};

use crate::error::ApplyPatchError;
use crate::filesystem::{FileSystem, PathKind};
use crate::model::PinnedResolvedPath;

const MAX_SYMLINK_DEPTH: usize = 40;

pub(crate) fn normalize_root(root: &Path) -> Result<PathBuf, ApplyPatchError> {
  let absolute = if root.is_absolute() {
    root.to_path_buf()
  } else {
    std::env::current_dir()
      .map_err(ApplyPatchError::CurrentDirectory)?
      .join(root)
  };
  Ok(normalize_lexically(&absolute))
}

pub(crate) fn resolve_patch_path(
  root: &Path,
  patch_path: &Path,
  filesystem: &dyn FileSystem,
) -> Result<PinnedResolvedPath, ApplyPatchError> {
  let lexical = absolute_lexical_path(root, patch_path);
  observe_absolute_path(&lexical, filesystem)
}

pub(crate) fn absolute_lexical_path(root: &Path, patch_path: &Path) -> PathBuf {
  if patch_path.is_absolute() {
    normalize_lexically(patch_path)
  } else {
    normalize_lexically(&root.join(patch_path))
  }
}

fn observe_absolute_path(
  lexical: &Path,
  filesystem: &dyn FileSystem,
) -> Result<PinnedResolvedPath, ApplyPatchError> {
  debug_assert!(lexical.is_absolute());

  let mut current = lexical.to_path_buf();
  for _ in 0..MAX_SYMLINK_DEPTH {
    if let Ok(resolved_target) = filesystem.canonicalize(&current) {
      return Ok(PinnedResolvedPath {
        lexical: lexical.to_path_buf(),
        resolved_target: normalize_lexically(&resolved_target),
      });
    }

    let (canonical_ancestor, remainder) = deepest_canonical_ancestor(&current, filesystem)?;
    let first_unresolved = canonical_ancestor.join(&remainder[0]);
    match filesystem.lexical_entry_kind(&first_unresolved) {
      Err(source) if source.kind() == io::ErrorKind::NotFound => {
        let resolved_target = remainder
          .iter()
          .fold(canonical_ancestor, |path, component| path.join(component));
        return Ok(PinnedResolvedPath {
          lexical: lexical.to_path_buf(),
          resolved_target: normalize_lexically(&resolved_target),
        });
      }
      Ok(PathKind::Symlink) => {
        let target = filesystem
          .read_link(&first_unresolved)
          .map_err(|source| ApplyPatchError::path_resolution(&first_unresolved, source))?;
        let target = if target.is_absolute() {
          target
        } else {
          first_unresolved
            .parent()
            .expect("a path below a canonical ancestor has a parent")
            .join(target)
        };
        current = remainder
          .iter()
          .skip(1)
          .fold(target, |path, component| path.join(component));
        current = normalize_lexically(&current);
      }
      Ok(_) => {
        return Err(ApplyPatchError::path_resolution(
          &current,
          io::Error::new(
            io::ErrorKind::NotADirectory,
            format!(
              "{} is not a symlink or traversable directory",
              first_unresolved.display()
            ),
          ),
        ));
      }
      Err(source) => {
        return Err(ApplyPatchError::path_resolution(&first_unresolved, source));
      }
    }
  }

  Err(ApplyPatchError::path_resolution(
    lexical,
    io::Error::other("too many symbolic links while resolving path"),
  ))
}

fn deepest_canonical_ancestor(
  path: &Path,
  filesystem: &dyn FileSystem,
) -> Result<(PathBuf, Vec<PathBuf>), ApplyPatchError> {
  let mut ancestor = path;
  let mut remainder = Vec::new();

  loop {
    let Some(name) = ancestor.file_name() else {
      return Err(ApplyPatchError::path_resolution(
        path,
        io::Error::new(io::ErrorKind::NotFound, "no canonical ancestor found"),
      ));
    };
    remainder.push(PathBuf::from(name));
    let Some(parent) = ancestor.parent() else {
      return Err(ApplyPatchError::path_resolution(
        path,
        io::Error::new(io::ErrorKind::NotFound, "no canonical ancestor found"),
      ));
    };
    ancestor = parent;

    if let Ok(canonical) = filesystem.canonicalize(ancestor) {
      remainder.reverse();
      return Ok((canonical, remainder));
    }
  }
}

pub(crate) fn normalize_lexically(path: &Path) -> PathBuf {
  let mut normalized = PathBuf::new();

  for component in path.components() {
    match component {
      Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
      Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
      Component::CurDir => {}
      Component::ParentDir => {
        if normalized.file_name().is_some() {
          normalized.pop();
        }
      }
      Component::Normal(value) => normalized.push(value),
    }
  }

  normalized
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::filesystem::OsFileSystem;

  #[test]
  fn normalizes_parent_components_without_confining_to_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let pinned_path =
      resolve_patch_path(&root, Path::new("../outside.txt"), &OsFileSystem).unwrap();
    assert_eq!(pinned_path.lexical, temp.path().join("outside.txt"));
    assert_eq!(
      pinned_path.resolved_target,
      std::fs::canonicalize(temp.path())
        .unwrap()
        .join("outside.txt")
    );
  }

  #[cfg(unix)]
  #[test]
  fn follows_existing_symlink_ancestors_for_missing_suffixes() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    symlink(&outside, root.join("link")).unwrap();

    let pinned_path =
      resolve_patch_path(&root, Path::new("link/missing/file.txt"), &OsFileSystem).unwrap();
    assert_eq!(
      pinned_path.resolved_target,
      std::fs::canonicalize(&outside)
        .unwrap()
        .join("missing")
        .join("file.txt")
    );
  }

  #[cfg(unix)]
  #[test]
  fn follows_dangling_symlinks_to_missing_targets() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    symlink(&outside, root.join("link")).unwrap();

    let pinned_path = resolve_patch_path(&root, Path::new("link/file.txt"), &OsFileSystem).unwrap();
    assert_eq!(
      pinned_path.resolved_target,
      std::fs::canonicalize(temp.path())
        .unwrap()
        .join("outside/file.txt")
    );
  }
}

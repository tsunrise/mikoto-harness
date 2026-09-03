use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::filesystem::{FileSystem, PathKind};

#[derive(Clone, Debug)]
enum VirtualEntry {
  Missing,
  File { contents: Option<Arc<str>> },
  Directory,
  Other,
}

/// A planning-only, lazy in-memory overlay over the approved canonical paths
/// in the base filesystem.
///
/// We cache each path when planning first inspects it, then apply writes only
/// to this overlay. This lets a later hunk observe an earlier hunk without
/// mutating the OS. However, this is not an atomic snapshot of the full tree:
/// paths that have not been inspected can still reflect changes in the base
/// filesystem.
pub(crate) struct VirtualFileSystem<'a> {
  base: &'a dyn FileSystem,
  entries: HashMap<PathBuf, VirtualEntry>,
}

impl<'a> VirtualFileSystem<'a> {
  pub(crate) fn new(base: &'a dyn FileSystem) -> Self {
    Self {
      base,
      entries: HashMap::new(),
    }
  }

  pub(crate) fn read_to_string(&mut self, path: &Path) -> io::Result<Arc<str>> {
    match self.load_entry(path)?.clone() {
      VirtualEntry::Missing => Err(not_found(path)),
      VirtualEntry::Directory => Err(is_directory(path)),
      VirtualEntry::Other => Err(not_regular_file(path)),
      VirtualEntry::File {
        contents: Some(contents),
      } => Ok(contents),
      VirtualEntry::File { contents: None } => {
        let contents = Arc::<str>::from(self.base.read_to_string(path)?);
        self.entries.insert(
          path.to_path_buf(),
          VirtualEntry::File {
            contents: Some(contents.clone()),
          },
        );
        Ok(contents)
      }
    }
  }

  pub(crate) fn create_dir_all(&mut self, path: &Path) -> io::Result<()> {
    // Walk from the root down so a missing component becomes a virtual
    // directory before we inspect its child. For example, creating `a/b`
    // must make a later attempt to write a regular file at `a` fail during
    // planning rather than after `a/b` has already been committed.
    let ancestors = path.ancestors().collect::<Vec<_>>();
    for directory in ancestors.into_iter().rev() {
      match self.load_entry(directory)?.clone() {
        VirtualEntry::Missing => {
          self
            .entries
            .insert(directory.to_path_buf(), VirtualEntry::Directory);
        }
        VirtualEntry::Directory => {}
        VirtualEntry::File { .. } => return Err(not_a_directory(directory, "a regular file")),
        VirtualEntry::Other => return Err(not_a_directory(directory, "not a directory")),
      }
    }
    Ok(())
  }

  pub(crate) fn write(&mut self, path: &Path, contents: Arc<str>) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
      io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{} has no parent directory", path.display()),
      )
    })?;
    match self.load_entry(parent)?.clone() {
      VirtualEntry::Directory => {}
      VirtualEntry::Missing => {
        return Err(io::Error::new(
          io::ErrorKind::NotFound,
          format!("parent {} does not exist", parent.display()),
        ));
      }
      VirtualEntry::File { .. } => return Err(not_a_directory(parent, "a regular file")),
      VirtualEntry::Other => return Err(not_a_directory(parent, "not a directory")),
    }

    match self.load_entry(path)?.clone() {
      VirtualEntry::Missing | VirtualEntry::File { .. } => {
        self.entries.insert(
          path.to_path_buf(),
          VirtualEntry::File {
            contents: Some(contents),
          },
        );
        Ok(())
      }
      VirtualEntry::Directory => Err(io::Error::new(
        io::ErrorKind::IsADirectory,
        "destination is a directory",
      )),
      VirtualEntry::Other => Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "destination is not a regular file",
      )),
    }
  }

  pub(crate) fn remove_file(&mut self, path: &Path) -> io::Result<()> {
    match self.load_entry(path)?.clone() {
      VirtualEntry::File { .. } => {
        self
          .entries
          .insert(path.to_path_buf(), VirtualEntry::Missing);
        Ok(())
      }
      VirtualEntry::Missing => Err(not_found(path)),
      VirtualEntry::Directory => Err(is_directory(path)),
      VirtualEntry::Other => Err(not_regular_file(path)),
    }
  }

  fn load_entry(&mut self, path: &Path) -> io::Result<&VirtualEntry> {
    // A virtual ancestor shadows everything below it. We check only ancestors
    // already present in the overlay; unknown ancestors remain lazy and are
    // left to the base's secure no-follow traversal.
    for ancestor in path.ancestors().skip(1) {
      match self.entries.get(ancestor) {
        Some(VirtualEntry::Missing) => {
          self
            .entries
            .insert(path.to_path_buf(), VirtualEntry::Missing);
          return Ok(
            self
              .entries
              .get(path)
              .expect("the missing descendant was inserted above"),
          );
        }
        Some(VirtualEntry::File { .. }) => {
          return Err(not_a_directory(ancestor, "a regular file"));
        }
        Some(VirtualEntry::Other) => {
          return Err(not_a_directory(ancestor, "not a directory"));
        }
        Some(VirtualEntry::Directory) | None => {}
      }
    }

    if self.entries.contains_key(path) {
      return Ok(
        self
          .entries
          .get(path)
          .expect("an entry found above remains in the overlay"),
      );
    }

    let entry = match self.base.canonical_entry_kind(path) {
      Ok(PathKind::File) => VirtualEntry::File { contents: None },
      Ok(PathKind::Directory) => VirtualEntry::Directory,
      Ok(PathKind::Symlink | PathKind::Other) => VirtualEntry::Other,
      Err(source) if source.kind() == io::ErrorKind::NotFound => VirtualEntry::Missing,
      Err(source) => return Err(source),
    };
    self.entries.insert(path.to_path_buf(), entry);
    Ok(
      self
        .entries
        .get(path)
        .expect("the base entry was inserted above"),
    )
  }
}

fn not_found(path: &Path) -> io::Error {
  io::Error::new(
    io::ErrorKind::NotFound,
    format!("{} does not exist", path.display()),
  )
}

fn is_directory(path: &Path) -> io::Error {
  io::Error::new(
    io::ErrorKind::IsADirectory,
    format!("{} is a directory", path.display()),
  )
}

fn not_regular_file(path: &Path) -> io::Error {
  io::Error::new(
    io::ErrorKind::InvalidInput,
    format!("{} is not a regular file", path.display()),
  )
}

fn not_a_directory(path: &Path, kind: &str) -> io::Error {
  io::Error::new(
    io::ErrorKind::NotADirectory,
    format!("{} is {kind}", path.display()),
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::filesystem::OsFileSystem;

  #[test]
  fn caches_reads_and_keeps_mutations_in_memory() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let existing = root.join("existing.txt");
    let created = root.join("new/nested.txt");
    std::fs::write(&existing, "base\n").unwrap();

    let mut filesystem = VirtualFileSystem::new(&OsFileSystem);
    assert_eq!(
      filesystem.read_to_string(&existing).unwrap().as_ref(),
      "base\n"
    );

    let initially_missing = root.join("initially-missing.txt");
    assert_eq!(
      filesystem
        .read_to_string(&initially_missing)
        .unwrap_err()
        .kind(),
      io::ErrorKind::NotFound
    );

    std::fs::write(&existing, "base changed\n").unwrap();
    std::fs::write(&initially_missing, "appeared later\n").unwrap();
    assert_eq!(
      filesystem.read_to_string(&existing).unwrap().as_ref(),
      "base\n"
    );
    assert_eq!(
      filesystem
        .read_to_string(&initially_missing)
        .unwrap_err()
        .kind(),
      io::ErrorKind::NotFound
    );

    filesystem
      .create_dir_all(created.parent().unwrap())
      .unwrap();
    filesystem.write(&created, Arc::from("virtual\n")).unwrap();
    filesystem.remove_file(&existing).unwrap();

    assert_eq!(
      filesystem.read_to_string(&created).unwrap().as_ref(),
      "virtual\n"
    );
    assert_eq!(
      filesystem.read_to_string(&existing).unwrap_err().kind(),
      io::ErrorKind::NotFound
    );
    assert!(!created.exists());
    assert_eq!(std::fs::read_to_string(existing).unwrap(), "base changed\n");
  }

  #[test]
  fn virtual_ancestors_control_descendant_operations() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let mut filesystem = VirtualFileSystem::new(&OsFileSystem);

    filesystem.create_dir_all(&root.join("directory")).unwrap();
    assert_eq!(
      filesystem
        .write(&root.join("directory"), Arc::from("file\n"))
        .unwrap_err()
        .kind(),
      io::ErrorKind::IsADirectory
    );

    filesystem
      .write(&root.join("parent.txt"), Arc::from("file\n"))
      .unwrap();
    assert_eq!(
      filesystem
        .read_to_string(&root.join("parent.txt/child.txt"))
        .unwrap_err()
        .kind(),
      io::ErrorKind::NotADirectory
    );

    filesystem.remove_file(&root.join("parent.txt")).unwrap();
    filesystem.create_dir_all(&root.join("parent.txt")).unwrap();
    filesystem
      .write(&root.join("parent.txt/child.txt"), Arc::from("child\n"))
      .unwrap();
    assert_eq!(
      filesystem
        .read_to_string(&root.join("parent.txt/child.txt"))
        .unwrap()
        .as_ref(),
      "child\n"
    );
  }
}

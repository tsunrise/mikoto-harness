use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PathKind {
  File,
  Directory,
  Symlink,
  Other,
}

pub(crate) trait FileSystem: Send + Sync {
  // Preparation-time operations intentionally inspect lexical paths and
  // follow symlinks to derive a pinned resolved target.
  fn lexical_entry_kind(&self, lexical_path: &Path) -> io::Result<PathKind>;
  fn canonicalize(&self, lexical_path: &Path) -> io::Result<PathBuf>;
  fn read_link(&self, lexical_path: &Path) -> io::Result<PathBuf>;

  // Application-time operations accept normalized absolute canonical paths.
  // Implementations must reject symlinks in every path component and fail
  // closed when descriptor-relative traversal is unsupported.
  fn canonical_entry_kind(&self, canonical_path: &Path) -> io::Result<PathKind>;
  fn read_to_string(&self, canonical_path: &Path) -> io::Result<String>;
  fn create_dir_all(&self, canonical_path: &Path) -> io::Result<()>;
  fn write(&self, canonical_path: &Path, contents: &[u8]) -> io::Result<()>;
  fn remove_file(&self, canonical_path: &Path) -> io::Result<()>;
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct OsFileSystem;

impl FileSystem for OsFileSystem {
  fn lexical_entry_kind(&self, lexical_path: &Path) -> io::Result<PathKind> {
    fs::symlink_metadata(lexical_path).map(|metadata| kind(&metadata))
  }

  fn canonical_entry_kind(&self, canonical_path: &Path) -> io::Result<PathKind> {
    secure::canonical_entry_kind(canonical_path)
  }

  fn canonicalize(&self, lexical_path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(lexical_path)
  }

  fn read_link(&self, lexical_path: &Path) -> io::Result<PathBuf> {
    fs::read_link(lexical_path)
  }

  fn read_to_string(&self, canonical_path: &Path) -> io::Result<String> {
    secure::read_to_string(canonical_path)
  }

  fn create_dir_all(&self, canonical_path: &Path) -> io::Result<()> {
    secure::create_dir_all(canonical_path)
  }

  fn write(&self, canonical_path: &Path, contents: &[u8]) -> io::Result<()> {
    secure::write(canonical_path, contents)
  }

  fn remove_file(&self, canonical_path: &Path) -> io::Result<()> {
    secure::remove_file(canonical_path)
  }
}

fn kind(metadata: &fs::Metadata) -> PathKind {
  let file_type = metadata.file_type();
  if file_type.is_symlink() {
    PathKind::Symlink
  } else if file_type.is_file() {
    PathKind::File
  } else if file_type.is_dir() {
    PathKind::Directory
  } else {
    PathKind::Other
  }
}

#[cfg(unix)]
mod secure {
  use std::ffi::{OsStr, OsString};
  use std::fs::File;
  use std::io::{self, Read, Write};
  use std::path::{Component, Path};

  use rustix::fd::OwnedFd;
  use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, fstat, mkdirat, open, openat, statat, unlinkat,
  };

  use super::PathKind;

  const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

  pub(super) fn canonical_entry_kind(canonical_path: &Path) -> io::Result<PathKind> {
    if canonical_path.parent().is_none() {
      validate_absolute(canonical_path)?;
      return Ok(PathKind::Directory);
    }

    let (parent, name) = open_parent(canonical_path, false)?;
    let metadata = statat(&parent, &name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
    Ok(path_kind(FileType::from_raw_mode(metadata.st_mode)))
  }

  pub(super) fn read_to_string(canonical_path: &Path) -> io::Result<String> {
    let (parent, name) = open_parent(canonical_path, false)?;
    let fd = openat(
      &parent,
      &name,
      OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
      Mode::empty(),
    )
    .map_err(io::Error::from)?;
    require_regular_file(&fd)?;

    let mut contents = String::new();
    File::from(fd).read_to_string(&mut contents)?;
    Ok(contents)
  }

  pub(super) fn create_dir_all(canonical_path: &Path) -> io::Result<()> {
    open_directory(canonical_path, true).map(drop)
  }

  pub(super) fn write(canonical_path: &Path, contents: &[u8]) -> io::Result<()> {
    let (parent, name) = open_parent(canonical_path, false)?;
    let fd = openat(
      &parent,
      &name,
      OFlags::WRONLY | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
      Mode::RUSR | Mode::WUSR | Mode::RGRP | Mode::WGRP | Mode::ROTH | Mode::WOTH,
    )
    .map_err(io::Error::from)?;
    require_regular_file(&fd)?;

    let mut file = File::from(fd);
    file.set_len(0)?;
    file.write_all(contents)
  }

  pub(super) fn remove_file(canonical_path: &Path) -> io::Result<()> {
    let (parent, name) = open_parent(canonical_path, false)?;
    let metadata = statat(&parent, &name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
    if !FileType::from_raw_mode(metadata.st_mode).is_file() {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "resolved path is not a regular file",
      ));
    }
    unlinkat(&parent, &name, AtFlags::empty()).map_err(io::Error::from)
  }

  fn open_parent(canonical_path: &Path, create: bool) -> io::Result<(OwnedFd, OsString)> {
    validate_absolute(canonical_path)?;
    let name = canonical_path
      .file_name()
      .ok_or_else(|| {
        io::Error::new(
          io::ErrorKind::InvalidInput,
          "resolved path has no file name",
        )
      })?
      .to_os_string();
    let parent = canonical_path
      .parent()
      .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "resolved path has no parent"))?;
    Ok((open_directory(parent, create)?, name))
  }

  fn open_directory(canonical_path: &Path, create: bool) -> io::Result<OwnedFd> {
    validate_absolute(canonical_path)?;
    let mut directory = open("/", DIRECTORY_FLAGS, Mode::empty()).map_err(io::Error::from)?;

    for component in canonical_path.components() {
      let Component::Normal(name) = component else {
        continue;
      };
      directory = open_directory_at(&directory, name, create)?;
    }

    Ok(directory)
  }

  fn open_directory_at(parent: &OwnedFd, name: &OsStr, create: bool) -> io::Result<OwnedFd> {
    match openat(parent, name, DIRECTORY_FLAGS, Mode::empty()) {
      Ok(directory) => Ok(directory),
      Err(error) if create && error == rustix::io::Errno::NOENT => {
        match mkdirat(
          parent,
          name,
          Mode::RWXU | Mode::RGRP | Mode::WGRP | Mode::XGRP | Mode::ROTH | Mode::WOTH | Mode::XOTH,
        ) {
          Ok(()) => {}
          Err(error) if error == rustix::io::Errno::EXIST => {}
          Err(error) => return Err(error.into()),
        }
        openat(parent, name, DIRECTORY_FLAGS, Mode::empty()).map_err(io::Error::from)
      }
      Err(error) => Err(error.into()),
    }
  }

  fn validate_absolute(canonical_path: &Path) -> io::Result<()> {
    if !canonical_path.is_absolute()
      || canonical_path.components().any(|component| {
        matches!(
          component,
          Component::CurDir | Component::ParentDir | Component::Prefix(_)
        )
      })
    {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "secure filesystem operations require a normalized absolute canonical path",
      ));
    }
    Ok(())
  }

  fn require_regular_file(fd: &OwnedFd) -> io::Result<()> {
    let metadata = fstat(fd).map_err(io::Error::from)?;
    if FileType::from_raw_mode(metadata.st_mode).is_file() {
      Ok(())
    } else {
      Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "resolved path is not a regular file",
      ))
    }
  }

  fn path_kind(file_type: FileType) -> PathKind {
    if file_type.is_file() {
      PathKind::File
    } else if file_type.is_dir() {
      PathKind::Directory
    } else if file_type.is_symlink() {
      PathKind::Symlink
    } else {
      PathKind::Other
    }
  }
}

// TODO(windows): Add a secure native Windows backend instead of falling
// through to the unsupported implementation below. Follow Codex's
// `exec-server/src/no_follow/windows.rs` design: use `NtCreateFile` with
// `OBJ_DONT_REPARSE` so the kernel rejects symlinks, junctions, mount points,
// and other reparse points in every path component. Reads and writes must
// additionally require a regular disk file; recursive directory creation must
// securely open or create each component; and deletion must operate through an
// opened handle with `SetFileInformationByHandle`. Accept only normalized
// absolute local-disk or UNC paths (including their verbatim forms), reject
// device namespaces and named pipes, and keep unsupported platforms
// fail-closed. End-to-end Windows support will also need consistent handling
// of verbatim path prefixes and case comparison at the policy boundary,
// lossless NAPI path conversion, Windows native-addon builds, and tests for
// leaf symlinks, ancestor junctions, named pipes, and normal file operations.
#[cfg(not(unix))]
mod secure {
  use std::io;
  use std::path::Path;

  use super::{PathKind, unsupported};

  pub(super) fn canonical_entry_kind(_canonical_path: &Path) -> io::Result<PathKind> {
    Err(unsupported())
  }

  pub(super) fn read_to_string(_canonical_path: &Path) -> io::Result<String> {
    Err(unsupported())
  }

  pub(super) fn create_dir_all(_canonical_path: &Path) -> io::Result<()> {
    Err(unsupported())
  }

  pub(super) fn write(_canonical_path: &Path, _contents: &[u8]) -> io::Result<()> {
    Err(unsupported())
  }

  pub(super) fn remove_file(_canonical_path: &Path) -> io::Result<()> {
    Err(unsupported())
  }
}

#[cfg(not(unix))]
fn unsupported() -> io::Error {
  io::Error::new(
    io::ErrorKind::Unsupported,
    "secure descriptor-relative filesystem operations are unavailable on this platform",
  )
}

#[cfg(all(test, unix))]
mod tests {
  use std::os::unix::fs::symlink;

  use super::*;

  #[test]
  fn secure_operations_do_not_follow_leaf_or_ancestor_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let outside = root.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("victim.txt"), "original\n").unwrap();

    symlink(outside.join("victim.txt"), root.join("leaf.txt")).unwrap();
    assert_eq!(
      OsFileSystem
        .canonical_entry_kind(&root.join("leaf.txt"))
        .unwrap(),
      PathKind::Symlink
    );
    assert!(OsFileSystem.read_to_string(&root.join("leaf.txt")).is_err());
    assert!(
      OsFileSystem
        .write(&root.join("leaf.txt"), b"changed\n")
        .is_err()
    );
    assert!(OsFileSystem.remove_file(&root.join("leaf.txt")).is_err());
    assert_eq!(
      std::fs::read_to_string(outside.join("victim.txt")).unwrap(),
      "original\n"
    );
    assert!(root.join("leaf.txt").symlink_metadata().is_ok());

    symlink(&outside, root.join("ancestor")).unwrap();
    assert!(
      OsFileSystem
        .create_dir_all(&root.join("ancestor/nested"))
        .is_err()
    );
    assert!(
      OsFileSystem
        .write(&root.join("ancestor/new.txt"), b"new\n")
        .is_err()
    );
    assert!(!outside.join("nested").exists());
    assert!(!outside.join("new.txt").exists());
  }

  #[test]
  fn secure_operations_create_and_mutate_regular_paths() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let directory = root.join("new/nested");
    let file = directory.join("file.txt");

    OsFileSystem.create_dir_all(&directory).unwrap();
    OsFileSystem.write(&file, b"first\n").unwrap();
    assert_eq!(OsFileSystem.read_to_string(&file).unwrap(), "first\n");
    OsFileSystem.write(&file, b"second\n").unwrap();
    assert_eq!(OsFileSystem.read_to_string(&file).unwrap(), "second\n");
    OsFileSystem.remove_file(&file).unwrap();
    assert!(!file.exists());
  }
}

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::model::ApplyPatchChange;

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ParseError {
  #[error("invalid patch: {0}")]
  InvalidPatch(String),

  #[error("invalid hunk at line {line_number}: {message}")]
  InvalidHunk { message: String, line_number: usize },
}

#[derive(Debug, Error)]
pub enum ApplyPatchError {
  #[error(transparent)]
  Parse(#[from] ParseError),

  #[error("patch contains no file operations")]
  EmptyPatch,

  #[error("failed to resolve current directory: {0}")]
  CurrentDirectory(#[source] io::Error),

  #[error("failed to resolve path {}: {source}", path.display())]
  PathResolution {
    path: PathBuf,
    #[source]
    source: io::Error,
  },

  #[error("cannot apply patch to {}: {message}", path.display())]
  Preflight { path: PathBuf, message: String },

  /// Keep replacement-matching failures byte-for-byte compatible with Codex.
  /// The message already contains its path and line details, so wrapping it in
  /// `Preflight` would add a second path and change the user-facing text.
  #[error("{0}")]
  ComputeReplacements(String),

  #[error("{action} {} failed: {source}", path.display())]
  Io {
    action: &'static str,
    path: PathBuf,
    #[source]
    source: io::Error,
  },

  #[error("patch application was cancelled before commit")]
  Cancelled,
}

impl ApplyPatchError {
  pub(crate) fn path_resolution(path: &Path, source: io::Error) -> Self {
    Self::PathResolution {
      path: path.to_path_buf(),
      source,
    }
  }

  pub(crate) fn preflight(path: &Path, message: impl Into<String>) -> Self {
    Self::Preflight {
      path: path.to_path_buf(),
      message: message.into(),
    }
  }

  pub(crate) fn io(action: &'static str, path: &Path, source: io::Error) -> Self {
    Self::Io {
      action,
      path: path.to_path_buf(),
      source,
    }
  }
}

#[derive(Debug)]
pub struct ApplyPatchFailure {
  error: ApplyPatchError,
  committed: Vec<ApplyPatchChange>,
  affected_paths: Vec<PathBuf>,
}

impl ApplyPatchFailure {
  pub(crate) fn new(
    error: ApplyPatchError,
    committed: Vec<ApplyPatchChange>,
    affected_paths: Vec<PathBuf>,
  ) -> Self {
    Self {
      error,
      committed,
      affected_paths,
    }
  }

  pub(crate) fn before_commit(error: ApplyPatchError) -> Self {
    Self::new(error, Vec::new(), Vec::new())
  }

  pub fn error(&self) -> &ApplyPatchError {
    &self.error
  }

  pub fn committed(&self) -> &[ApplyPatchChange] {
    &self.committed
  }

  pub fn affected_paths(&self) -> &[PathBuf] {
    &self.affected_paths
  }
}

impl fmt::Display for ApplyPatchFailure {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(formatter, "{}", self.error)?;

    if !self.committed.is_empty() {
      let paths = self
        .committed
        .iter()
        .map(|change| change.path.as_str())
        .collect::<Vec<_>>()
        .join(", ");
      write!(formatter, "; committed patch prefix: {paths}")?;
    }

    if !self.affected_paths.is_empty() {
      let paths = self
        .affected_paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
      write!(
        formatter,
        "; the failing operation may have affected: {paths}"
      )?;
    }

    Ok(())
  }
}

impl std::error::Error for ApplyPatchFailure {
  fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
    Some(&self.error)
  }
}

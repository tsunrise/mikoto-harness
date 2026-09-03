use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Hunk {
  AddFile {
    path: PathBuf,
    contents: String,
  },
  DeleteFile {
    path: PathBuf,
  },
  UpdateFile {
    path: PathBuf,
    move_path: Option<PathBuf>,
    chunks: Vec<UpdateFileChunk>,
  },
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct UpdateFileChunk {
  pub change_context: Option<String>,
  pub old_lines: Vec<String>,
  pub new_lines: Vec<String>,
  pub context_line_indices: Vec<(usize, usize)>,
  pub is_end_of_file: bool,
}

impl UpdateFileChunk {
  pub(crate) fn push_context_line(&mut self, line: String) {
    self
      .context_line_indices
      .push((self.old_lines.len(), self.new_lines.len()));
    self.old_lines.push(line.clone());
    self.new_lines.push(line);
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
/// Pins a patch's lexical path to the resolved target used for both policy
/// evaluation and filesystem operations. The lexical path is only the stable
/// key back to parsed hunks and user-facing output. Descriptor-relative
/// operations reject symlinks introduced anywhere in the resolved target
/// before a read or mutation, avoiding a later return to the lexical alias.
pub(crate) struct PinnedResolvedPath {
  pub(crate) lexical: PathBuf,
  pub(crate) resolved_target: PathBuf,
}

#[derive(Debug)]
pub struct PreparedPatch {
  pub(crate) root: PathBuf,
  pub(crate) hunks: Vec<Hunk>,
  /// Pins the resolved canonical path of each lexical path defined in each hunk.
  /// Those resolved canonical path mapping would be used when we finally apply the
  /// patch to filesystem. Such pin prevents drift of lexical path->canonical path
  /// between preparing to applying.
  pub(crate) pinned_resolved_paths: Vec<PinnedResolvedPath>,
}

impl PreparedPatch {
  pub fn root(&self) -> &Path {
    &self.root
  }

  pub fn targets(&self) -> impl ExactSizeIterator<Item = &Path> {
    self
      .pinned_resolved_paths
      .iter()
      .map(|pinned_path| pinned_path.resolved_target.as_path())
      .collect::<BTreeSet<_>>()
      .into_iter()
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplyPatchChangeKind {
  Added,
  Modified,
  Deleted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApplyPatchChange {
  pub kind: ApplyPatchChangeKind,
  pub path: String,
  pub move_path: Option<String>,
  pub additions: u32,
  pub deletions: u32,
  /// One display-oriented diff in the line-numbered format consumed by Pi's
  /// built-in `renderDiff()`. The path and optional move destination are
  /// already structured above, so we don't duplicate Git file and hunk headers
  /// in this string. A pure move has an empty diff because its contents did not
  /// change.
  ///
  /// ```text
  /// -1 const enabled = false;
  /// +1 const enabled = true;
  /// ```
  pub diff: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApplyPatchOutcome {
  pub changes: Vec<ApplyPatchChange>,
}

#[derive(Clone, Debug, Default)]
pub struct CancellationFlag {
  cancelled: Arc<AtomicBool>,
}

impl CancellationFlag {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn cancel(&self) {
    self.cancelled.store(true, Ordering::Release);
  }

  pub fn is_cancelled(&self) -> bool {
    self.cancelled.load(Ordering::Acquire)
  }
}

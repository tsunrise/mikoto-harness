use napi::Status;
use napi_derive::napi;

#[napi]
pub struct PreparedPatch {
  inner: Option<apply_patch_core::PreparedPatch>,
}

impl PreparedPatch {
  pub(crate) fn from_core(inner: apply_patch_core::PreparedPatch) -> Self {
    Self { inner: Some(inner) }
  }

  pub(crate) fn take(&mut self) -> Option<apply_patch_core::PreparedPatch> {
    self.inner.take()
  }
}

#[napi]
impl PreparedPatch {
  #[napi(getter)]
  pub fn targets(&self) -> napi::Result<Vec<String>> {
    let prepared = self.inner.as_ref().ok_or_else(|| {
      napi::Error::new(
        Status::InvalidArg,
        "PreparedPatch has already been consumed".to_string(),
      )
    })?;
    Ok(
      prepared
        .targets()
        .map(|path| path.to_string_lossy().into_owned())
        .collect(),
    )
  }
}

#[napi(string_enum)]
pub enum ApplyPatchChangeKind {
  #[napi(value = "added")]
  Added,
  #[napi(value = "modified")]
  Modified,
  #[napi(value = "deleted")]
  Deleted,
}

#[napi(object)]
pub struct ApplyPatchChange {
  pub kind: ApplyPatchChangeKind,
  pub path: String,
  pub move_path: Option<String>,
  pub additions: u32,
  pub deletions: u32,
  pub diff: String,
}

#[napi(object)]
pub struct ApplyPatchOutcome {
  pub changes: Vec<ApplyPatchChange>,
}

impl From<apply_patch_core::ApplyPatchOutcome> for ApplyPatchOutcome {
  fn from(outcome: apply_patch_core::ApplyPatchOutcome) -> Self {
    Self {
      changes: outcome.changes.into_iter().map(Into::into).collect(),
    }
  }
}

impl From<apply_patch_core::ApplyPatchChange> for ApplyPatchChange {
  fn from(change: apply_patch_core::ApplyPatchChange) -> Self {
    Self {
      kind: change.kind.into(),
      path: change.path,
      move_path: change.move_path,
      additions: change.additions,
      deletions: change.deletions,
      diff: change.diff,
    }
  }
}

impl From<apply_patch_core::ApplyPatchChangeKind> for ApplyPatchChangeKind {
  fn from(kind: apply_patch_core::ApplyPatchChangeKind) -> Self {
    match kind {
      apply_patch_core::ApplyPatchChangeKind::Added => Self::Added,
      apply_patch_core::ApplyPatchChangeKind::Modified => Self::Modified,
      apply_patch_core::ApplyPatchChangeKind::Deleted => Self::Deleted,
    }
  }
}

mod task;
mod types;

use std::path::PathBuf;

use napi::Status;
use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi_derive::napi;

pub use task::ApplyPatchTask;
pub use types::{ApplyPatchChange, ApplyPatchChangeKind, ApplyPatchOutcome, PreparedPatch};

#[napi]
pub fn prepare_patch(root: String, patch: String) -> napi::Result<PreparedPatch> {
  let prepared = apply_patch_core::prepare_patch(&PathBuf::from(root), &patch)
    .map_err(|error| napi::Error::new(Status::InvalidArg, error.to_string()))?;
  Ok(PreparedPatch::from_core(prepared))
}

#[napi]
pub fn apply_patch(
  prepared: &mut PreparedPatch,
  signal: Option<AbortSignal>,
) -> napi::Result<AsyncTask<ApplyPatchTask>> {
  let inner = prepared.take().ok_or_else(|| {
    napi::Error::new(
      Status::InvalidArg,
      "PreparedPatch has already been consumed".to_string(),
    )
  })?;

  let cancellation = apply_patch_core::CancellationFlag::new();
  if let Some(signal) = signal.as_ref() {
    let cancellation = cancellation.clone();
    signal.on_abort(move || cancellation.cancel());
  }

  Ok(AsyncTask::with_optional_signal(
    ApplyPatchTask::new(inner, cancellation),
    signal,
  ))
}

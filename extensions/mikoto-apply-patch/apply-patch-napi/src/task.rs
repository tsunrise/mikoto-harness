use napi::{Env, Status, Task};
use napi_derive::napi;

use crate::types::ApplyPatchOutcome;

pub struct ApplyPatchTask {
  prepared: Option<apply_patch_core::PreparedPatch>,
  cancellation: apply_patch_core::CancellationFlag,
}

impl ApplyPatchTask {
  pub(crate) fn new(
    prepared: apply_patch_core::PreparedPatch,
    cancellation: apply_patch_core::CancellationFlag,
  ) -> Self {
    Self {
      prepared: Some(prepared),
      cancellation,
    }
  }
}

#[napi]
impl Task for ApplyPatchTask {
  type Output = apply_patch_core::ApplyPatchOutcome;
  type JsValue = ApplyPatchOutcome;

  fn compute(&mut self) -> napi::Result<Self::Output> {
    let prepared = self.prepared.take().ok_or_else(|| {
      napi::Error::new(
        Status::GenericFailure,
        "native apply_patch task was already run".to_string(),
      )
    })?;
    apply_patch_core::apply_patch(prepared, &self.cancellation)
      .map_err(|failure| napi::Error::new(Status::GenericFailure, failure.to_string()))
  }

  fn resolve(&mut self, _env: Env, outcome: Self::Output) -> napi::Result<Self::JsValue> {
    Ok(outcome.into())
  }
}

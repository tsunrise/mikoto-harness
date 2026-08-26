use napi_derive::napi;

#[napi]
pub struct PreparedPatch {
    pub hello: String,
}

#[napi]
pub fn prepare_patch(_root: String, _patch: String) -> napi::Result<PreparedPatch> {
    // thin conversion layer
    Ok(PreparedPatch {
        hello: "world".into(),
    })
}

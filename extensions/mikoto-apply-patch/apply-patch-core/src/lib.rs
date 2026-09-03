mod apply;
mod diff;
mod error;
mod file_update;
mod filesystem;
mod model;
mod parser;
mod path_resolution;
mod prepare;
mod seek_sequence;
mod streaming_parser;
mod text_file;
mod virtual_filesystem;

pub use apply::apply_patch;
pub use error::{ApplyPatchError, ApplyPatchFailure, ParseError};
pub use model::{
  ApplyPatchChange, ApplyPatchChangeKind, ApplyPatchOutcome, CancellationFlag, Hunk, PreparedPatch,
  UpdateFileChunk,
};
pub use prepare::prepare_patch;

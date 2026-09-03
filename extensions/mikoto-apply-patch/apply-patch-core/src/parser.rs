//! Filesystem-independent parsing for the complete apply_patch input.

use crate::error::ParseError;
use crate::model::Hunk;
use crate::streaming_parser::StreamingPatchParser;

pub(crate) const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
pub(crate) const END_PATCH_MARKER: &str = "*** End Patch";
pub(crate) const ADD_FILE_MARKER: &str = "*** Add File: ";
pub(crate) const DELETE_FILE_MARKER: &str = "*** Delete File: ";
pub(crate) const UPDATE_FILE_MARKER: &str = "*** Update File: ";
pub(crate) const MOVE_TO_MARKER: &str = "*** Move to: ";
pub(crate) const EOF_MARKER: &str = "*** End of File";
pub(crate) const CHANGE_CONTEXT_MARKER: &str = "@@ ";
pub(crate) const EMPTY_CHANGE_CONTEXT_MARKER: &str = "@@";

#[derive(Debug)]
pub(crate) struct ParsedPatch {
  pub(crate) hunks: Vec<Hunk>,
}

pub(crate) fn parse_patch(patch: &str) -> Result<ParsedPatch, ParseError> {
  let lines = patch.trim().lines().collect::<Vec<_>>();
  let patch_lines = check_boundaries_lenient(&lines)?;
  let normalized = patch_lines.join("\n");

  let mut parser = StreamingPatchParser::default();
  parser.push_delta(&normalized)?;
  let hunks = parser.finish()?;

  Ok(ParsedPatch { hunks })
}

fn check_boundaries_strict<'a>(lines: &'a [&'a str]) -> Result<&'a [&'a str], ParseError> {
  let (first, last) = match lines {
    [] => (None, None),
    [only] => (Some(*only), Some(*only)),
    [first, .., last] => (Some(*first), Some(*last)),
  };

  match (first.map(str::trim), last.map(str::trim)) {
    (Some(BEGIN_PATCH_MARKER), Some(END_PATCH_MARKER)) => Ok(lines),
    (Some(first), _) if first != BEGIN_PATCH_MARKER => Err(ParseError::InvalidPatch(
      "the first line of the patch must be '*** Begin Patch'".to_string(),
    )),
    _ => Err(ParseError::InvalidPatch(
      "the last line of the patch must be '*** End Patch'".to_string(),
    )),
  }
}

fn check_boundaries_lenient<'a>(
  original_lines: &'a [&'a str],
) -> Result<&'a [&'a str], ParseError> {
  let original_error = match check_boundaries_strict(original_lines) {
    Ok(lines) => return Ok(lines),
    Err(error) => error,
  };

  match original_lines {
    [first, .., last]
      if matches!(*first, "<<EOF" | "<<'EOF'" | "<<\"EOF\"")
        && last.ends_with("EOF")
        && original_lines.len() >= 4 =>
    {
      check_boundaries_strict(&original_lines[1..original_lines.len() - 1])
    }
    _ => Err(original_error),
  }
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use super::*;
  use crate::model::UpdateFileChunk;

  #[test]
  fn parses_add_delete_update_and_move() {
    let parsed = parse_patch(
      r#"*** Begin Patch
*** Add File: new.txt
+new
*** Delete File: old.txt
*** Update File: source.txt
*** Move to: destination.txt
@@ section
-old
+new
*** End Patch"#,
    )
    .unwrap();

    assert_eq!(
      parsed.hunks,
      vec![
        Hunk::AddFile {
          path: PathBuf::from("new.txt"),
          contents: "new\n".to_string(),
        },
        Hunk::DeleteFile {
          path: PathBuf::from("old.txt"),
        },
        Hunk::UpdateFile {
          path: PathBuf::from("source.txt"),
          move_path: Some(PathBuf::from("destination.txt")),
          chunks: vec![UpdateFileChunk {
            change_context: Some("section".to_string()),
            old_lines: vec!["old".to_string()],
            new_lines: vec!["new".to_string()],
            context_line_indices: Vec::new(),
            is_end_of_file: false,
          }],
        },
      ]
    );
  }

  #[test]
  fn accepts_whitespace_padded_boundaries_and_legacy_heredoc() {
    let padded = " *** Begin Patch \n*** Add File: x\n+\n *** End Patch ";
    assert_eq!(parse_patch(padded).unwrap().hunks.len(), 1);

    let heredoc = "<<'EOF'\n*** Begin Patch\n*** Delete File: x\n*** End Patch\nEOF\n";
    assert_eq!(parse_patch(heredoc).unwrap().hunks.len(), 1);
  }

  #[test]
  fn rejects_environment_id_and_malformed_boundaries() {
    let environment = "*** Begin Patch\n*** Environment ID: remote\n*** End Patch";
    assert!(matches!(
      parse_patch(environment),
      Err(ParseError::InvalidHunk { line_number: 2, .. })
    ));

    assert!(matches!(
      parse_patch("*** Begin Patch\n*** Add File: x\n+x"),
      Err(ParseError::InvalidPatch(_))
    ));
  }

  #[test]
  fn preserves_end_of_file_marker() {
    let parsed = parse_patch(
      "*** Begin Patch\n*** Update File: x\n@@\n-old\n+new\n*** End of File\n*** End Patch",
    )
    .unwrap();
    let Hunk::UpdateFile { chunks, .. } = &parsed.hunks[0] else {
      panic!("expected update hunk");
    };
    assert!(chunks[0].is_end_of_file);
  }
}

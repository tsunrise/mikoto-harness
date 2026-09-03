use std::path::Path;

use crate::error::ApplyPatchError;
use crate::model::UpdateFileChunk;
use crate::seek_sequence::seek_sequence;
use crate::text_file::{Replacement, SourceFile};

pub(crate) fn derive_new_contents(
  path: &Path,
  original_contents: &str,
  chunks: &[UpdateFileChunk],
) -> Result<String, ApplyPatchError> {
  let mut source_file = SourceFile::parse(original_contents);
  let original_lines = source_file.line_texts();
  let replacements = compute_replacements(&original_lines, path, chunks)?;
  source_file.apply_replacements(&replacements);
  Ok(source_file.into_contents())
}

fn compute_replacements(
  original_lines: &[String],
  path: &Path,
  chunks: &[UpdateFileChunk],
) -> Result<Vec<Replacement>, ApplyPatchError> {
  let mut replacements = Vec::new();
  let mut line_index = 0;

  for chunk in chunks {
    if let Some(context_line) = &chunk.change_context {
      if let Some(index) = seek_sequence(
        original_lines,
        std::slice::from_ref(context_line),
        line_index,
        false,
      ) {
        line_index = index + 1;
      } else {
        return Err(ApplyPatchError::ComputeReplacements(format!(
          "Failed to find context '{context_line}' in {}",
          path.display()
        )));
      }
    }

    if chunk.old_lines.is_empty() {
      replacements.push((original_lines.len(), 0, chunk.new_lines.clone()));
      continue;
    }

    let mut pattern = chunk.old_lines.as_slice();
    let mut new_lines = chunk.new_lines.as_slice();
    let mut found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);

    if found.is_none() && pattern.last().is_some_and(String::is_empty) {
      pattern = &pattern[..pattern.len() - 1];
      if new_lines.last().is_some_and(String::is_empty) {
        new_lines = &new_lines[..new_lines.len() - 1];
      }
      found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);
    }

    let Some(start_index) = found else {
      return Err(ApplyPatchError::ComputeReplacements(format!(
        "Failed to find expected lines in {}:\n{}",
        path.display(),
        chunk.old_lines.join("\n")
      )));
    };

    // Context lines are deliberately omitted from replacements so their exact
    // contents and line endings survive in mixed-ending files.
    let mut old_start = 0;
    let mut new_start = 0;
    for &(old_context, new_context) in &chunk.context_line_indices {
      if old_context >= pattern.len() || new_context >= new_lines.len() {
        break;
      }
      if old_start != old_context || new_start != new_context {
        replacements.push((
          start_index + old_start,
          old_context - old_start,
          new_lines[new_start..new_context].to_vec(),
        ));
      }
      old_start = old_context + 1;
      new_start = new_context + 1;
    }
    if old_start != pattern.len() || new_start != new_lines.len() {
      replacements.push((
        start_index + old_start,
        pattern.len() - old_start,
        new_lines[new_start..].to_vec(),
      ));
    }

    line_index = start_index + pattern.len();
  }

  replacements.sort_by_key(|(index, _, _)| *index);
  Ok(replacements)
}

#[cfg(test)]
mod tests {
  use std::path::Path;

  use super::*;

  fn replacement(old: &str, new: &str) -> UpdateFileChunk {
    UpdateFileChunk {
      old_lines: vec![old.to_string()],
      new_lines: vec![new.to_string()],
      ..UpdateFileChunk::default()
    }
  }

  #[test]
  fn preserves_crlf_and_adds_trailing_newline() {
    let result = derive_new_contents(
      Path::new("x"),
      "one\r\ntwo\r\n",
      &[replacement("two", "changed")],
    )
    .unwrap();
    assert_eq!(result, "one\r\nchanged\r\n");

    let result =
      derive_new_contents(Path::new("x"), "one\ntwo", &[replacement("two", "changed")]).unwrap();
    assert_eq!(result, "one\nchanged\n");
  }

  #[test]
  fn preserves_unchanged_mixed_endings() {
    let chunk = UpdateFileChunk {
      old_lines: vec!["one".into(), "two".into(), "three".into()],
      new_lines: vec!["one".into(), "changed".into(), "three".into()],
      context_line_indices: vec![(0, 0), (2, 2)],
      ..UpdateFileChunk::default()
    };
    let result = derive_new_contents(Path::new("x"), "one\r\ntwo\nthree\r", &[chunk]).unwrap();
    assert_eq!(result, "one\r\nchanged\r\nthree\r");
  }

  #[test]
  fn reports_missing_context() {
    let error =
      derive_new_contents(Path::new("x"), "one\n", &[replacement("missing", "new")]).unwrap_err();
    assert_eq!(
      error.to_string(),
      "Failed to find expected lines in x:\nmissing"
    );
  }

  #[test]
  fn reports_missing_change_context() {
    let mut chunk = replacement("one", "new");
    chunk.change_context = Some("missing context".into());

    let error = derive_new_contents(Path::new("x"), "one\n", &[chunk]).unwrap_err();

    assert_eq!(
      error.to_string(),
      "Failed to find context 'missing context' in x"
    );
  }
}

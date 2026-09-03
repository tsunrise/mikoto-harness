use std::path::PathBuf;

use crate::error::ParseError;
use crate::model::{Hunk, UpdateFileChunk};
use crate::parser::{
  ADD_FILE_MARKER, BEGIN_PATCH_MARKER, CHANGE_CONTEXT_MARKER, DELETE_FILE_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER, END_PATCH_MARKER, EOF_MARKER, MOVE_TO_MARKER, UPDATE_FILE_MARKER,
};

#[derive(Debug, Default)]
pub(crate) struct StreamingPatchParser {
  line_buffer: String,
  state: StreamingParserState,
  line_number: usize,
}

#[derive(Debug, Default)]
struct StreamingParserState {
  mode: StreamingParserMode,
  hunks: Vec<Hunk>,
}

#[derive(Clone, Copy, Debug, Default)]
enum StreamingParserMode {
  #[default]
  NotStarted,
  StartedPatch,
  AddFile,
  DeleteFile,
  UpdateFile {
    hunk_line_number: usize,
  },
  EndedPatch,
}

impl StreamingPatchParser {
  fn ensure_update_hunk_is_not_empty(&self, line: &str) -> Result<(), ParseError> {
    if let Some(Hunk::UpdateFile { path, chunks, .. }) = self.state.hunks.last() {
      if chunks.is_empty()
        && let StreamingParserMode::UpdateFile { hunk_line_number } = self.state.mode
      {
        return Err(ParseError::InvalidHunk {
          message: format!("update file hunk for path '{}' is empty", path.display()),
          line_number: hunk_line_number,
        });
      }

      if chunks
        .last()
        .is_some_and(|chunk| chunk.old_lines.is_empty() && chunk.new_lines.is_empty())
      {
        let message = if line == END_PATCH_MARKER {
          "update hunk does not contain any lines".to_string()
        } else {
          invalid_update_line(line)
        };
        return Err(ParseError::InvalidHunk {
          message,
          line_number: self.line_number,
        });
      }
    }
    Ok(())
  }

  fn handle_header_or_end(&mut self, trimmed: &str) -> Result<bool, ParseError> {
    if trimmed == END_PATCH_MARKER {
      self.ensure_update_hunk_is_not_empty(trimmed)?;
      self.state.mode = StreamingParserMode::EndedPatch;
      return Ok(true);
    }

    if let Some(path) = trimmed.strip_prefix(ADD_FILE_MARKER) {
      self.ensure_update_hunk_is_not_empty(trimmed)?;
      self.state.hunks.push(Hunk::AddFile {
        path: PathBuf::from(path),
        contents: String::new(),
      });
      self.state.mode = StreamingParserMode::AddFile;
      return Ok(true);
    }

    if let Some(path) = trimmed.strip_prefix(DELETE_FILE_MARKER) {
      self.ensure_update_hunk_is_not_empty(trimmed)?;
      self.state.hunks.push(Hunk::DeleteFile {
        path: PathBuf::from(path),
      });
      self.state.mode = StreamingParserMode::DeleteFile;
      return Ok(true);
    }

    if let Some(path) = trimmed.strip_prefix(UPDATE_FILE_MARKER) {
      self.ensure_update_hunk_is_not_empty(trimmed)?;
      self.state.hunks.push(Hunk::UpdateFile {
        path: PathBuf::from(path),
        move_path: None,
        chunks: Vec::new(),
      });
      self.state.mode = StreamingParserMode::UpdateFile {
        hunk_line_number: self.line_number,
      };
      return Ok(true);
    }

    Ok(false)
  }

  pub(crate) fn push_delta(&mut self, delta: &str) -> Result<(), ParseError> {
    for character in delta.chars() {
      if character == '\n' {
        let mut line = std::mem::take(&mut self.line_buffer);
        if line.ends_with('\r') {
          line.pop();
        }
        self.line_number += 1;
        self.process_line(&line)?;
      } else {
        self.line_buffer.push(character);
      }
    }
    Ok(())
  }

  pub(crate) fn finish(mut self) -> Result<Vec<Hunk>, ParseError> {
    if !self.line_buffer.is_empty() {
      let line = std::mem::take(&mut self.line_buffer);
      self.line_number += 1;
      if line.trim() == END_PATCH_MARKER {
        self.ensure_update_hunk_is_not_empty(line.trim())?;
        self.state.mode = StreamingParserMode::EndedPatch;
      } else {
        self.process_line(&line)?;
      }
    }

    if !matches!(self.state.mode, StreamingParserMode::EndedPatch) {
      return Err(ParseError::InvalidPatch(
        "the last line of the patch must be '*** End Patch'".to_string(),
      ));
    }

    Ok(self.state.hunks)
  }

  fn process_line(&mut self, line: &str) -> Result<(), ParseError> {
    let trimmed = line.trim();
    match self.state.mode {
      StreamingParserMode::NotStarted => {
        if trimmed == BEGIN_PATCH_MARKER {
          self.state.mode = StreamingParserMode::StartedPatch;
          Ok(())
        } else {
          Err(ParseError::InvalidPatch(
            "the first line of the patch must be '*** Begin Patch'".to_string(),
          ))
        }
      }
      StreamingParserMode::StartedPatch => {
        if self.handle_header_or_end(trimmed)? {
          Ok(())
        } else {
          Err(self.invalid_hunk_header(trimmed))
        }
      }
      StreamingParserMode::AddFile => {
        if self.handle_header_or_end(trimmed)? {
          return Ok(());
        }
        if let Some(content) = line.strip_prefix('+')
          && let Some(Hunk::AddFile { contents, .. }) = self.state.hunks.last_mut()
        {
          contents.push_str(content);
          contents.push('\n');
          return Ok(());
        }
        Err(self.invalid_hunk_header(trimmed))
      }
      StreamingParserMode::DeleteFile => {
        if self.handle_header_or_end(trimmed)? {
          Ok(())
        } else {
          Err(self.invalid_hunk_header(trimmed))
        }
      }
      StreamingParserMode::UpdateFile { hunk_line_number } => {
        self.process_update_line(line, hunk_line_number)
      }
      StreamingParserMode::EndedPatch => {
        if trimmed.is_empty() {
          Ok(())
        } else {
          Err(ParseError::InvalidPatch(
            "the last line of the patch must be '*** End Patch'".to_string(),
          ))
        }
      }
    }
  }

  fn process_update_line(&mut self, line: &str, hunk_line_number: usize) -> Result<(), ParseError> {
    let update_line = line.trim_end();
    if self.handle_header_or_end(update_line)? {
      return Ok(());
    }

    let Some(Hunk::UpdateFile {
      move_path, chunks, ..
    }) = self.state.hunks.last_mut()
    else {
      unreachable!("update mode must have an update hunk");
    };

    if chunks.last().is_some_and(|chunk| chunk.is_end_of_file) {
      if update_line.is_empty() {
        return Ok(());
      }
      if update_line != EMPTY_CHANGE_CONTEXT_MARKER
        && !update_line.starts_with(CHANGE_CONTEXT_MARKER)
      {
        return Err(ParseError::InvalidHunk {
          message: format!("expected update hunk to start with a @@ context marker, got: '{line}'"),
          line_number: self.line_number,
        });
      }
    }

    if chunks.is_empty()
      && move_path.is_none()
      && let Some(destination) = update_line.strip_prefix(MOVE_TO_MARKER)
    {
      *move_path = Some(PathBuf::from(destination));
      self.state.mode = StreamingParserMode::UpdateFile { hunk_line_number };
      return Ok(());
    }

    if (update_line == EMPTY_CHANGE_CONTEXT_MARKER
      || update_line.starts_with(CHANGE_CONTEXT_MARKER))
      && chunks
        .last()
        .is_some_and(|chunk| chunk.old_lines.is_empty() && chunk.new_lines.is_empty())
    {
      return Err(ParseError::InvalidHunk {
        message: invalid_update_line(line),
        line_number: self.line_number,
      });
    }

    if update_line == EMPTY_CHANGE_CONTEXT_MARKER {
      chunks.push(UpdateFileChunk::default());
      return Ok(());
    }

    if let Some(context) = update_line.strip_prefix(CHANGE_CONTEXT_MARKER) {
      chunks.push(UpdateFileChunk {
        change_context: Some(context.to_string()),
        ..UpdateFileChunk::default()
      });
      return Ok(());
    }

    if update_line == EOF_MARKER {
      if chunks
        .last()
        .is_some_and(|chunk| chunk.old_lines.is_empty() && chunk.new_lines.is_empty())
      {
        return Err(ParseError::InvalidHunk {
          message: "update hunk does not contain any lines".to_string(),
          line_number: self.line_number,
        });
      }
      if let Some(chunk) = chunks.last_mut() {
        chunk.is_end_of_file = true;
      }
      return Ok(());
    }

    if line.is_empty() {
      ensure_chunk(chunks).push_context_line(String::new());
      return Ok(());
    }

    if let Some(context) = line.strip_prefix(' ') {
      ensure_chunk(chunks).push_context_line(context.to_string());
      return Ok(());
    }

    if let Some(added) = line.strip_prefix('+') {
      ensure_chunk(chunks).new_lines.push(added.to_string());
      return Ok(());
    }

    if let Some(removed) = line.strip_prefix('-') {
      ensure_chunk(chunks).old_lines.push(removed.to_string());
      return Ok(());
    }

    if chunks
      .last()
      .is_some_and(|chunk| !chunk.old_lines.is_empty() || !chunk.new_lines.is_empty())
    {
      return Err(ParseError::InvalidHunk {
        message: format!("expected update hunk to start with a @@ context marker, got: '{line}'"),
        line_number: self.line_number,
      });
    }

    Err(ParseError::InvalidHunk {
      message: invalid_update_line(line),
      line_number: self.line_number,
    })
  }

  fn invalid_hunk_header(&self, line: &str) -> ParseError {
    ParseError::InvalidHunk {
      message: format!(
        "'{line}' is not a valid hunk header; expected '*** Add File: {{path}}', \
         '*** Delete File: {{path}}', or '*** Update File: {{path}}'"
      ),
      line_number: self.line_number,
    }
  }
}

fn ensure_chunk(chunks: &mut Vec<UpdateFileChunk>) -> &mut UpdateFileChunk {
  if chunks.is_empty() {
    chunks.push(UpdateFileChunk::default());
  }
  chunks.last_mut().expect("a chunk was just inserted")
}

fn invalid_update_line(line: &str) -> String {
  format!("unexpected line in update hunk: '{line}'; every line must start with ' ', '+', or '-'")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accepts_character_by_character_streaming() {
    let patch = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
    let mut parser = StreamingPatchParser::default();
    for character in patch.chars() {
      parser.push_delta(&character.to_string()).unwrap();
    }
    assert_eq!(
      parser.finish().unwrap(),
      vec![Hunk::AddFile {
        path: PathBuf::from("hello.txt"),
        contents: "hello\n".to_string(),
      }]
    );
  }

  #[test]
  fn handles_crlf_and_bare_empty_context_lines() {
    let patch =
      "*** Begin Patch\r\n*** Update File: x\r\n@@\r\n before\r\n\r\n after\r\n*** End Patch\r\n";
    let mut parser = StreamingPatchParser::default();
    parser.push_delta(patch).unwrap();
    let hunks = parser.finish().unwrap();
    let Hunk::UpdateFile { chunks, .. } = &hunks[0] else {
      panic!("expected update");
    };
    assert_eq!(
      chunks[0].old_lines,
      vec!["before".to_string(), String::new(), "after".to_string()]
    );
  }

  #[test]
  fn accepts_a_whitespace_padded_final_marker() {
    let patch = "*** Begin Patch \n*** Update File: x\n@@\n-old\n+new\n *** End Patch";
    let mut parser = StreamingPatchParser::default();
    parser.push_delta(patch).unwrap();
    assert!(parser.finish().is_ok());
  }

  #[test]
  fn rejects_empty_update_chunks() {
    let patch = "*** Begin Patch\n*** Update File: x\n@@\n*** End Patch\n";
    let mut parser = StreamingPatchParser::default();
    assert!(matches!(
      parser.push_delta(patch),
      Err(ParseError::InvalidHunk { .. })
    ));
  }
}

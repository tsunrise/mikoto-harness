use std::borrow::Cow;
use std::fmt::Write;
use std::sync::Arc;

use similar::{ChangeTag, TextDiff};

use crate::model::{ApplyPatchChange, ApplyPatchChangeKind};

const CONTEXT_LINES: usize = 4;

#[derive(Debug)]
struct DisplayDiff {
  text: String,
  additions: u32,
  deletions: u32,
}

#[derive(Debug)]
pub(crate) struct FileContentChange {
  pub(crate) kind: ApplyPatchChangeKind,
  pub(crate) path: String,
  pub(crate) move_path: Option<String>,
  pub(crate) old_content: Option<Arc<str>>,
  pub(crate) new_content: Option<Arc<str>>,
}

pub(crate) fn build_changes(changes: Vec<FileContentChange>) -> Vec<ApplyPatchChange> {
  let mut rendered = Vec::with_capacity(changes.len());

  for change in changes {
    let old = change.old_content.as_deref();
    let new = change.new_content.as_deref();
    let display_diff = build_pi_display_diff(old.unwrap_or(""), new.unwrap_or(""));

    rendered.push(ApplyPatchChange {
      kind: change.kind,
      path: change.path,
      move_path: change.move_path,
      additions: display_diff.additions,
      deletions: display_diff.deletions,
      diff: display_diff.text,
    });
  }

  rendered
}

fn build_pi_display_diff(old_content: &str, new_content: &str) -> DisplayDiff {
  let old_content = normalize_to_lf(old_content);
  let new_content = normalize_to_lf(new_content);
  let text_diff = TextDiff::from_lines(old_content.as_ref(), new_content.as_ref());
  let mut additions = 0_u32;
  let mut deletions = 0_u32;
  for line_change in text_diff.iter_all_changes() {
    match line_change.tag() {
      ChangeTag::Insert => additions = additions.saturating_add(1),
      ChangeTag::Delete => deletions = deletions.saturating_add(1),
      ChangeTag::Equal => {}
    }
  }

  let line_number_width = old_content
    .split('\n')
    .count()
    .max(new_content.split('\n').count())
    .to_string()
    .len();
  let groups = text_diff.grouped_ops(CONTEXT_LINES);
  let mut output = String::new();

  for (group_index, group) in groups.iter().enumerate() {
    let first = group
      .first()
      .expect("a grouped diff always contains at least one operation");
    if group_index > 0 || first.old_range().start > 0 || first.new_range().start > 0 {
      push_ellipsis(&mut output, line_number_width);
    }

    for operation in group {
      for line_change in text_diff.iter_changes(operation) {
        match line_change.tag() {
          ChangeTag::Equal => push_numbered_line(
            &mut output,
            ' ',
            line_change
              .old_index()
              .expect("an unchanged line has an old line number")
              + 1,
            line_number_width,
            line_change.value(),
          ),
          ChangeTag::Delete => push_numbered_line(
            &mut output,
            '-',
            line_change
              .old_index()
              .expect("a deleted line has an old line number")
              + 1,
            line_number_width,
            line_change.value(),
          ),
          ChangeTag::Insert => push_numbered_line(
            &mut output,
            '+',
            line_change
              .new_index()
              .expect("an added line has a new line number")
              + 1,
            line_number_width,
            line_change.value(),
          ),
        }
      }
    }
  }

  if let Some(last) = groups.last().and_then(|group| group.last())
    && (last.old_range().end < text_diff.old_slices().len()
      || last.new_range().end < text_diff.new_slices().len())
  {
    push_ellipsis(&mut output, line_number_width);
  }

  DisplayDiff {
    text: output,
    additions,
    deletions,
  }
}

fn push_numbered_line(
  output: &mut String,
  prefix: char,
  line_number: usize,
  line_number_width: usize,
  value: &str,
) {
  push_line_separator(output);
  output.push(prefix);
  write!(output, "{line_number:>line_number_width$} ").expect("writing to a String cannot fail");
  output.push_str(value.strip_suffix('\n').unwrap_or(value));
}

fn push_ellipsis(output: &mut String, line_number_width: usize) {
  push_line_separator(output);
  output.push(' ');
  for _ in 0..line_number_width {
    output.push(' ');
  }
  output.push_str(" ...");
}

fn push_line_separator(output: &mut String) {
  if !output.is_empty() {
    output.push('\n');
  }
}

fn normalize_to_lf(contents: &str) -> Cow<'_, str> {
  if !contents.contains('\r') {
    return Cow::Borrowed(contents);
  }

  let mut normalized = String::with_capacity(contents.len());
  let bytes = contents.as_bytes();
  let mut segment_start = 0;
  let mut index = 0;
  while index < bytes.len() {
    if bytes[index] != b'\r' {
      index += 1;
      continue;
    }

    normalized.push_str(&contents[segment_start..index]);
    normalized.push('\n');
    index += if bytes.get(index + 1) == Some(&b'\n') {
      2
    } else {
      1
    };
    segment_start = index;
  }
  normalized.push_str(&contents[segment_start..]);
  Cow::Owned(normalized)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn renders_pi_display_diffs_for_add_update_move_and_delete() {
    let changes = vec![
      FileContentChange {
        kind: ApplyPatchChangeKind::Added,
        path: "new.txt".into(),
        move_path: None,
        old_content: None,
        new_content: Some(Arc::from("new\n")),
      },
      FileContentChange {
        kind: ApplyPatchChangeKind::Modified,
        path: "old.txt".into(),
        move_path: Some("moved.txt".into()),
        old_content: Some(Arc::from("old\n")),
        new_content: Some(Arc::from("changed\n")),
      },
      FileContentChange {
        kind: ApplyPatchChangeKind::Deleted,
        path: "gone.txt".into(),
        move_path: None,
        old_content: Some(Arc::from("gone\n")),
        new_content: None,
      },
    ];

    let changes = build_changes(changes);
    assert_eq!(changes[0].diff, "+1 new");
    assert_eq!(changes[1].diff, "-1 old\n+1 changed");
    assert_eq!(changes[2].diff, "-1 gone");
    assert_eq!(changes[1].additions, 1);
    assert_eq!(changes[1].deletions, 1);
  }

  #[test]
  fn leaves_the_display_diff_empty_for_a_pure_move() {
    let changes = build_changes(vec![FileContentChange {
      kind: ApplyPatchChangeKind::Modified,
      path: "old.txt".into(),
      move_path: Some("moved.txt".into()),
      old_content: Some(Arc::from("same\n")),
      new_content: Some(Arc::from("same\n")),
    }]);

    assert!(changes[0].diff.is_empty());
    assert_eq!(changes[0].additions, 0);
    assert_eq!(changes[0].deletions, 0);
  }

  #[test]
  fn renders_context_line_numbers_and_ellipsis_like_pi() {
    let old = (1..=12)
      .map(|line| format!("line {line}\n"))
      .collect::<String>();
    let new = old.replace("line 6\n", "changed\n");
    let changes = build_changes(vec![FileContentChange {
      kind: ApplyPatchChangeKind::Modified,
      path: "file.txt".into(),
      move_path: None,
      old_content: Some(Arc::from(old)),
      new_content: Some(Arc::from(new)),
    }]);

    assert_eq!(
      changes[0].diff,
      concat!(
        "    ...\n",
        "  2 line 2\n",
        "  3 line 3\n",
        "  4 line 4\n",
        "  5 line 5\n",
        "- 6 line 6\n",
        "+ 6 changed\n",
        "  7 line 7\n",
        "  8 line 8\n",
        "  9 line 9\n",
        " 10 line 10\n",
        "    ...",
      )
    );
  }

  #[test]
  fn normalizes_line_endings_in_the_display_diff() {
    let changes = build_changes(vec![FileContentChange {
      kind: ApplyPatchChangeKind::Modified,
      path: "file.txt".into(),
      move_path: None,
      old_content: Some(Arc::from("one\r\ntwo\rthree\n")),
      new_content: Some(Arc::from("one\r\nchanged\rthree\n")),
    }]);

    assert_eq!(changes[0].diff, " 1 one\n-2 two\n+2 changed\n 3 three");
    assert!(!changes[0].diff.contains('\r'));
  }
}

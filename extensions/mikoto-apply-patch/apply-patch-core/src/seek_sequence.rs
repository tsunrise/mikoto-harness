pub(crate) fn seek_sequence(
  lines: &[String],
  pattern: &[String],
  start: usize,
  eof: bool,
) -> Option<usize> {
  if pattern.is_empty() {
    return Some(start);
  }
  if pattern.len() > lines.len() {
    return None;
  }

  let last_start = lines.len() - pattern.len();
  let search_start = if eof { last_start.max(start) } else { start };
  if search_start > last_start {
    return None;
  }

  find_with(lines, pattern, search_start, |left, right| left == right)
    .or_else(|| {
      find_with(lines, pattern, search_start, |left, right| {
        left.trim_end() == right.trim_end()
      })
    })
    .or_else(|| {
      find_with(lines, pattern, search_start, |left, right| {
        left.trim() == right.trim()
      })
    })
    .or_else(|| {
      find_with(lines, pattern, search_start, |left, right| {
        normalize_punctuation(left) == normalize_punctuation(right)
      })
    })
}

fn find_with(
  lines: &[String],
  pattern: &[String],
  start: usize,
  matches: impl Fn(&str, &str) -> bool,
) -> Option<usize> {
  let last_start = lines.len() - pattern.len();
  (start..=last_start).find(|index| {
    pattern
      .iter()
      .enumerate()
      .all(|(offset, expected)| matches(&lines[index + offset], expected))
  })
}

fn normalize_punctuation(value: &str) -> String {
  value
    .trim()
    .chars()
    .map(|character| match character {
      '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' | '\u{2212}' => {
        '-'
      }
      '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
      '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
      '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}' | '\u{2007}'
      | '\u{2008}' | '\u{2009}' | '\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
      other => other,
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn lines(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
  }

  #[test]
  fn matches_with_codex_tolerances() {
    let source = lines(&["before", "  hello   ", "after"]);
    assert_eq!(
      seek_sequence(&source, &lines(&["hello"]), 0, false),
      Some(1)
    );

    let unicode = lines(&["smart—quote\u{00a0}here"]);
    assert_eq!(
      seek_sequence(&unicode, &lines(&["smart-quote here"]), 0, false),
      Some(0)
    );
  }

  #[test]
  fn eof_matching_does_not_move_before_start() {
    let source = lines(&["same", "same"]);
    assert_eq!(seek_sequence(&source, &lines(&["same"]), 1, true), Some(1));
  }
}

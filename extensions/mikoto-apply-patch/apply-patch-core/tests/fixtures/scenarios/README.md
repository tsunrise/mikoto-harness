# Apply-patch scenarios

These portable end-to-end fixtures are adapted from the Apache-2.0 OpenAI
Codex `apply-patch` scenario suite. Each scenario contains an optional
`input/` tree, a `patch.txt`, and the expected final tree under `expected/`.

The fixture runner remains a unit test in `src/apply.rs`; this directory
contains data only.

Files ending in `.hex` represent the bytes of the same path without the
extension. This keeps CRLF and mixed-line-ending fixtures stable even when
source-control or editor settings normalize text files.

The upstream checkout currently contains 25 directories because it has two
different `020_*` scenarios. All 25 are represented here. Scenario 015 is
intentionally adapted: Codex commits its first hunk before the later logical
failure, while Mikoto's full preflight requires the workspace to remain empty.

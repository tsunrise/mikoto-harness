# Mikoto Apply Patch

## Non-negotiable invariants

- Keep the provider-facing tool compatible with Codex: it is an OpenAI raw
  custom/freeform tool constrained by the exact Lark grammar, never a JSON
  function fallback. Do not add prompt snippets or guidance that changes the
  model-visible contract.
- Gate activation on both a known raw-grammar Pi adapter and
  `compat.supportsOpenAIGrammarTools === true`. Preserve and restore the exact
  native `edit` and `write` activation state when models change.
- Parse once with `preparePatch()`. Treat `PreparedPatch` as opaque and
  single-use: read only its policy targets, then pass that same object to
  `applyPatch()`.
- Keep preparation metadata-only. Policy checks for every pinned canonical
  target must finish before content reads, planning, or mutation.
- Do not treat `ctx.cwd` as a sandbox. Relative paths resolve from it, but
  absolute paths and `..` remain valid when policy allows them.
- Keep evaluation and mutation aligned on the same pinned canonical target.
  Secure filesystem operations must reject symlinks in every leaf and
  ancestor component and fail closed where secure descriptor-relative
  traversal is unavailable.
- Preflight all logical operations before commit. Commit is intentionally
  non-transactional for operating-system failures and must report the
  committed prefix.
- Honor cancellation before commit, never during commit.
- Keep Rust patch and diff sizes uncapped. Bound call previews and TUI
  rendering, but preserve Codex's exact, newline-terminated model-facing
  outcome summary.
- Render `ApplyPatchChange.diff` directly with Pi's exported `renderDiff()`.
  It is Pi's numbered display format, not a machine-applicable patch. If a
  machine patch is added later, give it a separate field.
- The virtual filesystem is a lazy, repeatable planning fork, not an execution
  backend. Its inherent mutable methods return normalized `io::Result`; the
  planner owns ordered `FsOperation` commit records and adds patch-specific
  context.
- Preserve Codex-compatible parser, replacement matching, error text, and
  line-ending behavior unless a deliberate compatibility change is requested.

## Generated files

- Do not hand-edit the NAPI-RS-generated `native/index.js`,
  `native/index.d.ts`, or platform `.node` binaries.
- Keep the handwritten TypeScript boundary in `src/native.ts`; regenerate
  native artifacts with the package build scripts.

## Tests

- Keep Rust unit and scenario tests colocated in `#[cfg(test)]` modules.
  Reserve Rust `tests/` directories for fixtures only.
- Add TypeScript tests under `test/` for transport, activation, policy,
  preview, rendering, and NAPI integration changes.
- Preserve all applicable Codex fixture scenarios and byte-exact line-ending
  coverage.

## Build instructions

Install JavaScript dependencies from the `mikoto-harness` repository root:

```sh
npm install
```

From the `mikoto-harness` repository root, build the native addon with:

```sh
npm run build --workspace mikoto-apply-patch
```

The `--workspace mikoto-apply-patch` selector is only required when running
the command from the repository root. From this extension directory, run:

```sh
npm run build
```

The default build is an optimized release build. For a faster development
build with debug information, use `build:debug` in the same location:

```sh
# From the mikoto-harness repository root
npm run build:debug --workspace mikoto-apply-patch

# Or from this extension directory
npm run build:debug
```

Use this script instead of invoking `cargo build` directly. It builds the
`apply-patch-napi` crate and generates the platform-specific `.node` binary,
ESM loader, and TypeScript declarations under `native/`.

## Code updates after install

If you only updated the TypeScript code, the changes are picked up
automatically.

If you updated the Rust code, run the build command again.

## Validation

From the `mikoto-harness` repository root, run:

```sh
npm run validate --workspace mikoto-apply-patch
cargo test --manifest-path extensions/mikoto-apply-patch/Cargo.toml --workspace
cargo clippy --manifest-path extensions/mikoto-apply-patch/Cargo.toml \
  --workspace --all-targets -- -D warnings
cargo fmt --manifest-path extensions/mikoto-apply-patch/Cargo.toml \
  --all -- --check
git diff --check
```

# Mikoto Apply Patch

`mikoto-apply-patch` provides Codex's grammar-constrained `apply_patch` tool. 

## Behavior

When the selected model supports OpenAI grammar tools, the extension:

- exposes `apply_patch` as a raw custom/freeform tool rather than a JSON
  function tool;
- temporarily replaces Pi's native `edit` and `write` tools;

Switching to an incompatible model removes `apply_patch` and restores the
native tools that were active before the replacement.

The currently supported Pi API adapters are:

- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `openai-completions`

The selected model must also set
`compat.supportsOpenAIGrammarTools` to `true`. The extension does not activate
on adapters that would fall back to a JSON function tool.

## Guardrails

This extension provides optional integration with `mikoto-policy`. Load `mikoto-policy`
before this extension to enable it.

When enabled, `mikoto-apply-patch` respects the policy's filesystem write
rules:

- every file being added, modified, or deleted must be allowed by
  `allowWrite` and not blocked by `denyWrite`;
- a move checks both its source and destination; and
- if any path is denied or cannot be evaluated, the whole patch is rejected
  without changing files.

Symlink paths are checked against the location they actually point to. A
symlink inside an allowed workspace therefore cannot grant access to a target
outside that workspace. The resolved target is fixed for the patch, so
changing the symlink afterward cannot redirect the write. If a new symlink is
introduced anywhere in that fixed target path before mutation, the patch is
rejected.

If `mikoto-policy` is not loaded, no policy rules are applied.

## Build

Install dependencies from the `mikoto-harness` repository root:

```sh
npm install
```

Build the optimized native addon:

```sh
npm run build --workspace mikoto-apply-patch
```

For a faster development build with debug information:

```sh
npm run build:debug --workspace mikoto-apply-patch
```

From this extension directory, omit the workspace selector:

```sh
npm run build
npm run build:debug
```

The NAPI build writes the platform-specific addon, ESM loader, and generated
TypeScript declarations to `native/`.

## Validation

Run the TypeScript checks and tests:

```sh
npm run validate --workspace mikoto-apply-patch
```

Run the Rust checks:

```sh
cargo test --manifest-path extensions/mikoto-apply-patch/Cargo.toml --workspace
cargo clippy --manifest-path extensions/mikoto-apply-patch/Cargo.toml \
  --workspace --all-targets -- -D warnings
cargo fmt --manifest-path extensions/mikoto-apply-patch/Cargo.toml \
  --all -- --check
```

The Rust commands above assume the current directory is the
`mikoto-harness` repository root.

## Layout

- `src/` contains the Pi extension, policy bridge, activation logic, previews,
  and rendering.
- `apply-patch-core/` contains the filesystem-independent patch engine and
  secure filesystem implementation.
- `apply-patch-napi/` exposes the opaque prepared plan and asynchronous apply
  task to Node.js.
- `native/` contains NAPI-RS-generated loading artifacts and the built addon.
- `test/` contains TypeScript integration and rendering tests.

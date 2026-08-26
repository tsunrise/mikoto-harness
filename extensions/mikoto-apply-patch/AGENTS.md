# Build Instruction

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

## Code Update After Install

If you only updated the TypeScript code, the changes are picked up
automatically.

If you updated the Rust code, run the build command again.

# Mikoto Harness

This is a mono-repo of multiple Pi extensions, shared libraries, and skills.
All extension and shared-library packages have brand name "Mikoto" to
differentiate them from similar packages outside the repo.

## Repo Tree Structure

- All extensions live in the `extensions` directory, with one package per
  subdirectory.
- All shared libraries live in the `shared` directory, with one package per
  subdirectory.
- All skills live in the `skills` directory.

The root `package.json` uses npm workspaces `extensions/*` and `shared/*`.
Install dependencies from the repository root. Keep package-local scripts so a
single package can still be checked or tested without running the whole
workspace.

## Naming

When naming an extension:
- The package name should have prefix `mikoto-`.
- The displayed name must contain keyword "Mikoto".

This branding requirement is for package name / displayed name only. No need to include `Mikoto` in context exposed to LLM. For example, tool name `apply_patch` is better than `mikoto_apply_patch`.

When naming a skill:
- Do not mention `mikoto` any branding related information.

## License

All extensions, shared libraries, and skills respect the [LICENSE](LICENSE)
file at repo root. We define another license file in their directory only if
the extensions/libraries are MOSTLY COPIED from their source. An adapted
skill/extension could just keep a README.md section acknowledging the author
of original ideas without separate definition of LICENSE.

## Extension entry point

Each Pi Extension should use this convention for entry point:

```
|- src/
   |- index.ts
|- index.ts
```

`src/index.ts` is the actual entry point, and `index.ts` is a thin wrapper of the `src/index.ts`.

In `package.json`, use
```json
"pi": {
	"extensions": [
		"./index.ts"
	]
}
```

## Inter-extension Interaction

We rely on a Pi event-bus for message passing between extensions inside this repo. Refer to `docs/inter-extensions.md`
for more details.

## Indentation

Use 2 spaces as one level of code indentation.

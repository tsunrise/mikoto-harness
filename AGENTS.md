# Mikoto Harness

This is a mono-repo of multiple Pi extensions and shared libraries. Some
extensions bundle related Pi skills. All extension and shared-library packages
have brand name "Mikoto" to differentiate them from similar packages outside
the repo.

## Repo Tree Structure

- All extensions live in the `extensions` directory, with one package per
  subdirectory.
- All shared libraries live in the `shared` directory, with one package per
  subdirectory.
- Skills tied to an extension live in that extension's `skills` directory. Do
  not create a top-level `skills` directory.

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

## Permission-aware Extensions

When creating or changing an extension that evaluates permissions or requests
user escalation, read and follow `docs/permission.md`. Keep generic event-bus
conventions in `docs/inter-extensions.md`; permission-specific lifecycle,
authorization, and escalation rules belong in `docs/permission.md`.

## Indentation

Use 2 spaces as one level of code indentation.

## Testing

Test code behavior, not the presence or absence of text in source files,
prompts, documentation, or manifests. Do not add source-text searches,
wording checklists, or assertions that merely repeat static file contents,
including through a function that returns that content.

Invoke the code and assert observable behavior: state transitions, validation,
serialization, escaping, side effects, rendering, and runtime loading or
packaging. UI tests must not assert exact authored wording in labels, titles,
hints, descriptions, or notifications. Copy edits should not break tests.
Instead, verify selection and cancellation, focus, visibility, layout bounds,
styling, state-dependent rendering, and emitted actions. Do not move expected
copy into fixtures just to hide the coupling.

Text assertions are appropriate for behavioral contracts such as caller-supplied
data being displayed or omitted, terminal escaping, serialized protocol fields,
and bytes written by a tool—not for checking authored prose.

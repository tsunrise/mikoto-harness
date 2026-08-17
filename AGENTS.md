# Mikoto Harness

This is a mono-repo of multiple Pi extensions and skills. All extensions have brand name "Mikoto" to differentiate from similar extensions outside the repo. 

## Repo Tree Structure

- Each extension takes a directory in the repo root.
- All skills live in the `skills` directory.

## Naming

When naming an extension:
- The package name should have prefix `mikoto-`.
- The displayed name must contain keyword "Mikoto".

This branding requirement is for package name / displayed name only. No need to include `Mikoto` in context exposed to LLM. For example, tool name `apply_patch` is better than `mikoto_apply_patch`. 

When naming a skill:
- Do not mention `mikoto` any branding related information.

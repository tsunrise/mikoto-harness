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

## License

All extensions and skills are respecting [LICENSE](LICENSE) file at repo root. No need to define another license file inside extension/skills folder.

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

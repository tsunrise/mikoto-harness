# Mikoto Harness: An opinionated agent setup for Pi

This repository contains extensions and skills for
[Pi Coding Agent](https://pi.dev/) that serve as building blocks for my
personal agent system *Mikoto*.

## Repository layout

- `extensions/*` contains independently installable Pi extension packages.
- `shared/*` contains declaration-only or runtime libraries shared by
  extensions.
- `skills/*` contains Pi skills.

The root is a private npm workspace.

```bash
npm install

# Validate one package without running the entire workspace:
npm run validate -w mikoto-sound

# Explicitly validate every package:
npm run validate
```

## Extension Interoperability

- Some extensions in the repo require one or more extensions in the repo to be
  loaded first.
- No extensions in the repo require an extension outside this repo.
- Every extension in the repo guarantees no conflict with the other extensions
  in this repo.
- No extensions guarantee compatibility with extensions outside this repo.

## Disclosure on LLM use

Code is heavily assisted with LLM but I know what I am doing and have spent human time. 
Check git history for proof.

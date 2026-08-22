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

## LLM usage disclosure

As an engineer, I care about code quality, but I don't have sufficient time / attention to
make every code on par to my standard. Therefore, I'm putting different effort to different components. 
I respect your time, so I honestly disclose my human effort spent on 
each code component, in corresponding `README.md`s. My "effort level" are classified into 
following categories:

- 📝 I own the code: 
  - I spent a lot of human effort on code level. 
  - The code is still heavily LLM assisted but  
  - I own all the low-level code design. This reflects my code quality at work.
- 🏗️ I only own the architecture: 
  - I defined the architecuture and LLM wrote most code one-shot from scratch. 
  - I reviewed those code similar to how I review other's PR/MR, but I don't really own the code. 
- 💡 I only own the idea: 
  - I have the idea but I didn't really review the architecture AND code. 
  - Given that I did not spend much time on this component, shouldn't you. Just get the idea, and don't waste your time reading the code.


## Extension Interoperability

- Some extensions in the repo require one or more extensions in the repo to be
  loaded first.
- No extensions in the repo require an extension outside this repo.
- Every extension in the repo guarantees no conflict with the other extensions
  in this repo.
- No extensions guarantee compatibility with extensions outside this repo.

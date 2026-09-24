# Mikoto Plan

Conversational planning with a Markdown file as the deliverable, followed by
an explicit return to ordinary execution. Requires **Pi 0.87.1** or later;
automated API tests are pinned to Pi 0.87.1.

## Load alongside Mikoto Question

From the outer workspace, try the local packages without changing settings:

```sh
pi -e ./mikoto-harness/extensions/mikoto-question/index.ts \
   -e ./mikoto-harness/extensions/mikoto-plan/index.ts
```

## Commands

| Input | Effect |
| --- | --- |
| `/plan` | Select Plan mode in memory for the next prompt and show its pending/active status. No model request or history entry. |
| `/plan <prompt>` | Enter Plan mode and submit one user prompt. |
| Ordinary input while planning | Research, clarify, or revise the plan file—even “implement it” means plan implementation. |
| `/lgtm` | Select Default mode in memory for the next prompt and show its pending/active status. No message, history entry, or automatic implementation. |
| `/lgtm <prompt>` | Exit to Default mode and submit one user prompt, such as “implement the plan”. |

## Plan files and research

The session's absolute `ctx.cwd`, captured when entering Plan mode, defines
`workspaceRoot`. New plans go to:

```text
<workspaceRoot>/docs/plans/<local-YYYYMMDD>-<short-kebab-task-name>.md
```

## Custom Messages 

The extension appends messages in following format when entering/exitting plan mode. 

  ```text
  <collaboration_mode>
  ...instructions and delimited workspace path data...
  </collaboration_mode>
  ```

The prompts in `prompts/` are model neutral: they say the message comes from
the harness and describe the user's choice of mode as context, without
referring to a message role, because the same text is delivered as a
developer, system, or user message depending on the model.

The session stores it as a custom message directly after the user prompt
that triggered the switch, so the session tree shows the order the model
receives. On each request, models with
`compat.supportsMidConvoSystemMessages = true` receive it as a native Pi
system message, which the provider adapter serializes:

| API | Wire form |
| --- | --- |
| `openai-responses`, `openai-codex-responses` | `developer` item after the prompt |
| `anthropic-messages` | `role: "system"` message after the prompt's user turn ([placement rules](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)) |

Pi's built-in catalog sets the flag for GPT-5.6 and GPT-6 on the OpenAI API
and Codex, and for Claude Opus 5, Opus 5.5, Fable 5, and Fable 5.1 on the
Anthropic API. Set it in `models.json` for custom providers that accept
mid-conversation system messages.

Other models (for example Claude Sonnet 5, which Anthropic does not support
for this feature) receive the same wrapped body as a **user** message. Pi
would otherwise fold later system messages into the leading system prompt,
invalidating the prompt cache on every mode switch.

## Validation

From `mikoto-harness/`:

```sh
npm install --ignore-scripts
npm run validate -w mikoto-plan
npm run check
```

## License and attribution

Prompt templates are inspired by [Codex](https://github.com/openai/codex/blob/40b0409aa1816d2a99935cbe77da66505c05c2a0/codex-rs/collaboration-mode-templates/templates/plan.md?plain=1#L1).

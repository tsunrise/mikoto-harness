# Mikoto Plan

Conversational planning with a Markdown file as the deliverable, followed by
an explicit return to ordinary execution. Requires Pi's extension hooks;
automated API tests are pinned to **Pi 0.85.1**.

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
  <developer_message>
  <collaboration_mode>
  ...instructions and delimited workspace path data...
  </collaboration_mode>
  </developer_message>
  ```

For `openai-codex-responses` and `openai-responses` with `compat.supportsDeveloperRole = true`, this message is sent using `developer` role.

Other transports (and developer-role-disabled Responses backends) receive the
same wrapped body as a **user** message. 

## Validation

From `mikoto-harness/`:

```sh
npm install --ignore-scripts
npm run validate -w mikoto-plan
npm run check
```

## License and attribution

Prompt templates are inspired by [Codex](https://github.com/openai/codex/blob/40b0409aa1816d2a99935cbe77da66505c05c2a0/codex-rs/collaboration-mode-templates/templates/plan.md?plain=1#L1).

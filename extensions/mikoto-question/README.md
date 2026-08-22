# Mikoto Question

Mikoto Question is a Pi extension that adds OpenAI Codex's
`request_user_input` tool contract and an interactive terminal questionnaire.
It also provides a turn-scoped Do not disturb mode.

## LLM Usage Disclosure

My effort on this extension: 🏗️ I only own the architecture

Refer to repo [README.md](../../README.md#LLM_usage_disclosure) for more details.

## Install

Install directly from a local checkout:

```bash
pi install /absolute/path/to/mikoto-harness/extensions/mikoto-question
```

From the Mikoto Harness repository root, run Pi with the extension temporarily:

```bash
pi -e ./extensions/mikoto-question
```

The questionnaire requires Pi's interactive TUI. Calls in RPC, JSON, and print
modes fail immediately rather than waiting for input.

## Tool contract

The extension registers the always-active `request_user_input` tool. It is not
restricted to a plan mode.

Example input:

```json
{
  "questions": [
    {
      "id": "database",
      "header": "Database",
      "question": "Which database should we use?",
      "options": [
        {
          "label": "PostgreSQL (Recommended)",
          "description": "Use a mature relational database."
        },
        {
          "label": "SQLite",
          "description": "Keep deployment simple."
        }
      ]
    }
  ]
}
```

The UI automatically adds `None of the above`; the model should not include an
“Other” option. The result sent back to the model follows Codex's response
shape:

```json
{
  "answers": {
    "database": {
      "answers": [
        "PostgreSQL (Recommended)",
        "user_note: Optional details"
      ]
    }
  }
}
```

## Questionnaire controls

- **Up/Down**: move through choices.
- **1–9**: select a numbered choice and advance.
- **Space**: commit the highlighted choice without advancing.
- **Enter**: select and advance/submit.
- **Tab**: add optional notes; Tab or Escape clears notes and returns.
- **Left/Right** or **Ctrl+P/Ctrl+N**: change question.
- **Backspace/Delete**: clear a selection.
- **Escape** while choosing: interrupt the request and current agent operation.

The configured Pi select, submit, and interrupt keybindings are honored. Before
submitting unanswered questions, the UI asks whether to proceed or go back.

There is deliberately no timeout, countdown, or automatic resolution.

When a questionnaire is about to open, Mikoto Question emits the optional
`mikoto-sound:sound` event with the `require-attention` effect. If Mikoto Sound
is loaded, this plays an attention sound immediately before the user-facing UI
appears. The event is fire-and-forget, so questionnaires behave identically
when the sound extension is absent.

## Do not disturb

Toggle DND with:

```text
/toggle-do-not-disturb
```

While active:

- Every `request_user_input` call returns a recoverable error telling the model
  that the user is temporarily unavailable and to make reasonable assumptions.
- No questionnaire opens.

Each state change adds a transcript message:

```text
Do not disturb mode is on
Do not disturb mode is off
```

These messages are UI-only custom entries and are never sent to the LLM. DND
automatically turns off at Pi's next `turn_end`, which adds the `off` message.
Before the next user-started agent run, the extension separately adds one hidden
custom-role context message saying that the user is available again.

If DND is turned on after a turn ends but before the next turn starts, it stays
on and the pending availability message is deferred while the current state is
on. If it is manually turned off again before submitting, the current state is
off and the completed turn's pending availability message is emitted. Toggles
after a turn ends do not alter whether that completed turn used DND.

## Development

```bash
# From the Mikoto Harness root:
npm install
npm run validate -w mikoto-question

# Or from this package directory:
npm run validate
```

The tests cover the Codex-compatible schema and response, questionnaire state
and rendering, DND lifecycle and UI messages, and extension integration.

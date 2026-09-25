# Mikoto Question

Mikoto Question is a Pi extension that adds OpenAI Codex's
`request_user_input` tool contract and an interactive terminal questionnaire.

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

The square strip above the prompt shows one square per question: `■` means
answered and `□` means unanswered. The current question uses the theme's accent
color; the other squares use normal text color. Highlighting an option alone
does not mark it answered.

While tool arguments stream, the transcript previews the available question
text. That preview disappears when streaming completes, leaving the questions
in the interactive questionnaire. Completed calls show a compact `Question`
heading, an answered count (for example, `• 3/3 answered`), and the questions,
selected answers, and any notes.

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

## Development

```bash
# From the Mikoto Harness root:
npm install
npm run validate -w mikoto-question

# Or from this package directory:
npm run validate
```

The tests cover the Codex-compatible schema and response, questionnaire state
and rendering, and extension integration.

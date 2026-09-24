# Mikoto Policy

Mikoto Policy is a Pi extension that enforces filesystem permissions for Pi's
built-in file tools and exposes a policy API to dependent extensions in Mikoto
Harness.

## Configuration

See [PERMISSION.md](PERMISSION.md) for policy semantics.

Run `/mikoto-policy:view` to display the active config paths and resolved
canonical policy, escalation settings and load diagnostics. Reviewer settings
are shown separately and are never added to the main permission prompt.
Policy changes and policy-rule symlink changes take effect
after `/reload`.

The JSON Schema is available at
[mikoto-policy.schema.json](mikoto-policy.schema.json).

## Path terminology

- A **lexical path** is a path with possible symlink redirection.
- A **canonical path** is the target path after resolving existing symlink
  redirections; it contains no symlink redirections at the time it is resolved.

## Behavior

Built-in tool calls to `read`, `grep`, `find`, `ls`, `write`, and `edit` are
enforced according to the configured policy. Filesystem authorization is split
into three stages with separate responsibilities:

1. **Target determination** owns lexical-to-canonical path resolution. It pins
   the exact canonical target that the tool proposes to access. A failure to
   determine that target denies the operation.
2. **Policy evaluation** owns the allow-or-deny decision for the pinned
   canonical target. Evaluation is filesystem-independent, accepts normalized
   absolute canonical paths only, and does not resolve symlinks.
3. **Tool execution or commit** owns canonical-path enforcement. The tool must
   operate on the exact canonical target that policy approved rather than
   reopening the lexical path.

Policy rule paths are also resolved to canonical paths when the policy is
loaded and remain pinned until `/reload`. Missing paths are supported by
resolving their deepest existing ancestor and appending the missing suffix. A
rule that cannot be resolved for another reason is dropped and reported as a
warning during `session_start`. An allow rule that resolves outside its
configured lexical tree is likewise dropped and reported.

`bash` is not enforced in this extension and it should be enforced in other
extensions.

The extension adds a `<permission>` block to the system prompt so the agent is
aware of the effective filesystem and network policies.

## Escalation

`escalation` selects `ask-me` (default, TUI only), `auto-review` (all execution
modes), or `always-deny` (no UI/model calls). Existing configurations remain
manual; automatic review is opt-in. Example configuration, not an automatic
change to your workspace:

```json
{
  "escalation": "auto-review",
  "autoReview": {
    "agent": {
      "provider": "openai-codex",
      "model": "gpt-6-luna",
      "thinkingLevel": "low"
    },
    "policy": "Require explicit user authorization before uploading workspace files."
  }
}
```

Layers replace `escalation`, `autoReview.agent`, and `autoReview.policy`
independently. An agent override must include all three fields; partial, empty,
null and flat agent objects are invalid. A policy-only override preserves the
inherited agent; `policy: ""` clears inherited custom rules. Empty `autoReview`
changes nothing. Provider/model names must be nonblank and trimmed. Thinking
levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

The private reviewer resolves the configured model through Pi's registry,
including normal credentials and supported thinking-level mapping. An absent
model is an error, not permission to substitute the parent model. Policy-load
errors, provider errors, timeouts and exhausted budgets deny without a manual
fallback. Optional missing layers and skipped untrusted-workspace config are
benign. Custom policy is literal trusted text, not a file path or template.

Reviews use the exact prepared action, parent instructions/context files, and a
role-preserving session projection. Only human requests and validated answers
from the loaded Mikoto Question tool can establish human authorization. The
private loop exposes stat/read/list/literal-search tools only, constrained by
current read policy; no shell, network, parent tools or recursive escalation.
Path/descriptor identity checks reduce races but are not a kernel sandbox.

Risk follows the operation's actual effects, not the presence of dangerous-looking
strings, missing source, host authority, or an earlier refusal alone.
By default, non-destructive access to reputable unlisted domains without sending
workspace data or secrets is allowed, as are writes outside `allowWrite` that a
recent human message requested or clearly implied (sensitive files such as
credentials, keys, shell startup files or security config must be named). Source and
tool results can establish implementation facts without granting authorization.
When the distinction matters, the reviewer inspects referenced scripts and relevant
imports, distinguishing commands used as data from commands actually dispatched.
Explicit human re-approval can satisfy authorization after a denial; corrected
facts trigger risk reassessment, not an exemption from absolute denial rules.

Bounds: 90 seconds per active review, three assessment attempts, eight rounds
per attempt, 32 investigation calls; 256 KiB exact action envelope, 512 KiB
serialized input, at most 96,000 estimated input tokens and 8,192 output tokens
(also constrained by the model). Optional fragments are capped at 16 KiB;
reads/scans at 64 KiB, directory lists at 200 entries and searches at 100 matches.
Required action/custom-policy/newest-human material is never truncated to fit.
Optional history leaves 16,384 tokens and 96 KiB of headroom for investigation
rounds; required evidence may use the full budget. Reused conversations rebuild
when they would consume that headroom.
The private in-memory conversation checkpoints valid decisions, uses parent
deltas, and rebuilds after projection/config changes or budget pressure.

The manual dialog shows only the tool name and decision/reason controls.
Inspect complete operation details in Pi's pending tool call. Both paths
authorize only the frozen operation, never a future retry. Rejections use
ordinary tool errors; there are no decision entries, progress displays or
reviewer messages in the parent conversation. Old decision entries are ignored
and left untouched. Roll back with `escalation: "ask-me"` and `/reload`.

### Investigation diagnostics

In the TUI, `/mikoto-policy:review-debug on` opts into a bounded, memory-only trace
starting with the next active review. `/mikoto-policy:review-debug show` (or the
command without arguments) displays it only in the UI; `off` disables capture and
clears it. There are no automatic progress notifications or debug file writes.
Reload, session replacement, tree navigation, and shutdown disable and clear it.

Only the latest review's request/tool identifiers, model-call attempt count,
investigation tool names, requested/canonical paths, completion/truncation status,
and sanitized failure category are retained. There are no commands, search queries,
file contents, provider output, assessments, or reasoning in the trace. Metadata
strings are escaped and bounded. This command neither changes policy nor enables
execution, and is a no-op outside the TUI.

An `ok` read means bounded content was returned to the reviewer, not proof that it
understood that content. `denied`, `missing`, and `failed` are not successful reads.
Zero investigation calls does not prove source was unavailable: it may already
have appeared in supplied evidence. `completed` means a valid assessment, whether
allow or deny, rather than approval or execution. Queued/admission rejections are
not active reviews and do not create a trace.

## Inter-extension API

Dependent extensions obtain the session policy through
`mikoto-policy:get-policy` and request one-operation decisions through
`mikoto-policy:escalate`. Load Policy first and use the same `mikoto-types`
commit.

See [Building permission-aware extensions](../../docs/permission.md) for the
integration contract and examples.

## Development

From the Mikoto Harness root:

```bash
npm run validate -w mikoto-policy
```

The minimum/development baseline is Pi **0.87.1**. Tests cover real SDK
integration and built-in interception as well as broker/UI races.
For a no-operation real-TUI smoke test, explicitly load
`test/fixtures/escalation-smoke.ts` after this extension and run
`/escalation-smoke`. In `ask-me` it rejects in print, JSON, and RPC modes.
Use isolated temporary configuration for automatic-review smoke tests; a live
test needs the configured model and normal Pi auth. Do not substitute another
model and call that a test of the default.

For explicit, decision-only live calibration against the configured
`openai-codex/gpt-6-luna`, run from the intended policy workspace:

```bash
NODE_USE_ENV_PROXY=1 node /path/to/mikoto-harness/extensions/mikoto-policy/scripts/review-probes.ts --live
```

This development script uses the bundled, global, and trusted workspace
configuration, Pi's stored OAuth credentials, and an in-memory model catalog.
Run it sandboxed; it does not need a host-authority launch. It creates temporary
fixtures and submits candidate actions as data to `AutoReviewer`, never to an
executor, regardless of the verdict. Investigator reads are restricted to those
fixtures; real credentials and home files are inaccessible to that investigator.
Its read-only credential adapter uses Pi's SDK and refuses token refreshes,
credential writes, and write locks. If credentials need refreshing, refresh them
in normal Pi before rerunning; the probe does not rotate tokens only in memory.
`NODE_USE_ENV_PROXY=1` makes Node honor Garden's supplied HTTP(S) proxy rather than
attempting direct network connections; the sandbox's domain rules still apply.

Cases cover a requested read, credential upload, broad deletion, a report-only
program, a nearly identical program that dispatches approved report commands,
and report printing after a synthetic prior denial and explicit re-approval.
The script never runs either program. Unit tests establish their differing effects
using inert fs/process/executor doubles. Live script cases require successful
source inspection as well as the expected decision; infrastructure failures do
not count as safety denials. Custom policy may intentionally change the expected
baseline decisions. The script prints only results and investigation metadata
and removes its generated fixtures on normal completion.

Core escalation lives in `src/escalate/{index,api,broker,ui}.ts`; built-in
policy enforcement requests decisions directly from the broker.
The private reviewer lives in `src/escalate/auto-review/`.

### Acknowledgment

The synchronous guardian interaction, risk/authorization taxonomy and
assessment field names are inspired by OpenAI Codex at commit `e0ef5a1a0f`.
Mikoto's instructions and implementation are an original adaptation using
Pi's model registry and narrower read-only filesystem tools, not Codex's
private guardian endpoint or executable.

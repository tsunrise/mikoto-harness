# Garden test scope

Test behavior, not appearance. The user has reviewed the UI; colors, badges,
backgrounds, borders, titles, help text, padding, line widths and footer
placement are not regression-test contracts. Do not add snapshots or repeat
functional tests for each theme.

UI entry points still own functional behavior:

- completion coalescing and suppression after collection/reset;
- terminal-control sanitization and credential isolation;
- non-consuming inspection and access to full command/output data;
- navigation, refresh, dismissal, exact-ID stop confirmation, cancellation,
  paste immunity, duplicate-dispatch prevention and stale-generation guards;
- accurate authorization scope and inspectable input/control bytes.

Prefer request/callback assertions and structured tool results. When rendering
is the boundary being tested, check fixture data or forbidden disclosure, not
surrounding labels, ANSI styling or a fixed page layout. Model-facing tool
output, prompt guidance and output budgets are functional contracts, not UI
styling.

`tui-smoke.exp` remains a no-model interaction smoke test. Its open/close
markers come from the explicitly loaded `pi-fixture.ts`, not production UI
strings. Stop and approval success are checked against actual tool results.
Keep its redraw draining and disabled transcript logging: debug deliberately
shows a live credential. One theme run is sufficient; the optional third
argument can still select a theme for manual inspection.

The executor, manager, HTTP, lifecycle, RPC, skill, type, Gate 1 and packed
executor fixtures cover distinct boundaries. Similar operations at those
layers are not automatically redundant. Query-string rejection is covered by
the raw HTTP framing test rather than repeated in the general HTTP smoke.

`tools.spec.ts` checks the public wait floor/caps at the dispatched-request
boundary, without sleeping through each case. `executor-client.spec.ts` uses
the compiled child without starting SRT to cover pending-request shutdown and
single initialization. These are functional tests, not presentation checks.

## Running

From the harness repository:

```sh
npm run validate -w mikoto-garden
```

The full suite requires an environment that permits local listeners, process
inspection and nested macOS sandbox execution. The separate TUI smoke also
requires a PTY. Do not weaken tests, silently skip failures, or request host
authority contrary to the user's instructions just to obtain a green run.

The component-only subset needs none of those host facilities:

```sh
node --test extensions/mikoto-garden/test/ui.spec.ts \
  extensions/mikoto-garden/test/process-picker.spec.ts \
  extensions/mikoto-garden/test/commands.spec.ts
```

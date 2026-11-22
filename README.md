# pi-summarize

A [pi](https://github.com/earendil-works/pi) extension package with two features, both driven by a cheap side model:

1. **Live activity line.** While the agent works, the working indicator shows one short, specific present-progressive line (≤ 12 words) describing the goal rather than the command, e.g. `Checking why the sync test fails`. Tool calls summarize immediately; text and thinking summarize at most every ~2 s. Subagents run their own copy of the extension and narrate themselves; the parent shows only what a tool reports as its own progress. While a tool runs, the line shows elapsed time every 5 s (display only, not recorded), so long waits visibly move. Only pi-projects' `role_agent` (which reports what the role run is doing) replaces the line with the last line of its own progress (`onUpdate` partial results) plus the elapsed time, until it ends; other tools' progress (bash's raw log, subagents' tool counts) leaves the line alone. Calls are cancelled when superseded or when the run ends, and failures or timeouts (10 s) fall back to a deterministic line such as `Reading files.js…` or `Working…`.

   In the transcript, tool rows are hidden. Each step (one model turn that runs tools) leaves one breadcrumb, `◆ <summary>`, where its tool rows were, recorded at `turn_end` from that step's live line (waiting up to 2.5 s for it). A tool-only step with the same goal as the previous breadcrumb merges into it (recorded as a `continues` entry so hosts can group its tools); a step with its own lead-in text always gets its own breadcrumb. Ctrl+O (expand) brings back the tool rows and shows each summary's tool calls. Thinking is never written to the session. With `activity` off, tools render normally.
2. **Auto-title.** After the first assistant reply in a session with no name, it sets a 2–4 word session name. It never overwrites a name you set, and it does not retry once it has named the session.

Each breadcrumb and each generated title is persisted with `pi.appendEntry("pi-summarize", …)`. These custom entries are not sent to the LLM. Hosts can read them from the session JSONL.

```jsonc
// {"type":"custom","customType":"pi-summarize","data":{"kind":"activity","text":"Reading files.js…","at":1760000000000,"turn":2,"source":"fallback","toolCallIds":["t1"]}}
// {"type":"custom","customType":"pi-summarize","data":{"kind":"title","text":"Fix Sync Adapter","auto":true,"at":1760000000000}}
```

## Host integration

A non-TUI host (such as pi-web) needs only two things: show the extension's `setWorkingMessage` text as the live line (falling back to `Working…` when it is cleared), and render the `activity` entries above, grouping each step's tools by `toolCallIds`. An entry with `"continues": true` is a step that merged into the previous breadcrumb (its `text` repeats that breadcrumb); add its tools to that group instead of showing a new line. Subagents write their own `pi-summarize` activity entries into their session JSONL (the subagent `outputFile`).

## Install

From npm:

```sh
pi install npm:pi-summarize
```

From git:

```sh
pi install git:github.com/bry-guy/pi-summarize
```

From a local checkout:

```sh
pi install /path/to/pi-summarize
```

## Configuration

Set these in `~/.pi/agent/settings.json` under the `pi-summarize` key, or override with environment variables (env wins):

```json
{
  "pi-summarize": {
    "model": "anthropic/claude-haiku-5-5",
    "thinking": "low",
    "activity": true,
    "title": true
  }
}
```

| Setting | Env var | Default | Notes |
|---|---|---|---|
| `model` | `PI_SUMMARIZE_MODEL` | session's current model | `provider/id`. If not found, a warning is shown once and only fallback lines are used. |
| `thinking` | `PI_SUMMARIZE_THINKING` | `off` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Invalid values become `off`. |
| `activity` | `PI_SUMMARIZE_ACTIVITY` | `true` | Live working line. `0`/`false`/`off`/`no` disable it. |
| `title` | `PI_SUMMARIZE_TITLE` | `true` | Auto-title. Same false values. |

The extension reads `settings.json` from `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`). Project-level settings are not read.

## Try it

Run pi in the TUI and send a prompt that uses tools. The working line should change from the default spinner text to activity lines. After the first reply, the session name should be set (check `/name` or the session selector).

Non-interactive check:

```sh
cd /tmp && pi --session-dir /tmp/ps-sessions -p "list files in /tmp briefly"
grep '"customType":"pi-summarize"' /tmp/ps-sessions/*.jsonl
```

## Development

```sh
npm test   # node --test on test/*.test.ts (Node ≥ 22.18, native TS type stripping)
mise run release   # tests, refuses an already-published version, then npm publish
```

- `src/core.ts`: config, fallback lines, debounced `ActivityTracker`, auto-title rules. No pi imports.
- `extensions/index.ts`: pi wiring (events, model call via `ctx.modelRegistry.streamSimple`, `setWorkingMessage`, `appendEntry`, `setSessionName`).
- `test/core.test.ts`: unit tests with an injected mock completion.
- `test/extension.test.ts`: loads the extension against a fake pi API and mock registry.

## Limits

- Model calls use `streamSimple`, not `complete()`, because only `streamSimple` accepts a reasoning level. `complete()` is used in pi's own examples.
- Activity entries record `toolCallIds` but not `fromEntryIds`, because streaming events do not carry transcript entry ids.
- Each activity line costs one side-model call. A long run with text streaming makes roughly one call every 2 s. Use a small model.
- Only user-scope settings are read. The extension does not add a settings UI.

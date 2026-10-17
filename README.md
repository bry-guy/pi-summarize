# pi-summarize

A [pi](https://github.com/earendil-works/pi) extension package with two features, both driven by a cheap side model:

1. **Live activity line.** While the agent works, the working indicator shows one short, specific present-progressive line (≤ 12 words) describing the goal rather than the command, e.g. `Checking why the sync test fails`. Tool calls summarize immediately; text and thinking summarize at most every ~2 s. Subagents run their own copy of the extension and narrate themselves; the parent does not relay their progress. While a tool runs, the line shows elapsed time every 5 s (display only, not recorded), so long waits visibly move. Calls are cancelled when superseded or when the run ends, and failures or timeouts (10 s) fall back to a deterministic line such as `Reading files.js…` or `Working…`.

   In the transcript, tool rows and summary lines are hidden; only the live working line narrates. Ctrl+O (expand) shows the tool rows plus each recorded `◆ <summary>` with its thinking tail and tool calls. With `activity` off, tools render normally.
2. **Auto-title.** After the first assistant reply in a session with no name, it sets a 2–4 word session name. It never overwrites a name you set, and it does not retry once it has named the session.

Each shown line and each generated title is persisted with `pi.appendEntry("pi-summarize", …)`. These custom entries are not sent to the LLM. Hosts can read them from the session JSONL.

```jsonc
// {"type":"custom","customType":"pi-summarize","data":{"kind":"activity","text":"Reading files.js…","at":1760000000000,"turn":2,"source":"fallback","toolCallIds":["t1"]}}
// {"type":"custom","customType":"pi-summarize","data":{"kind":"title","text":"Fix Sync Adapter","auto":true,"at":1760000000000}}
```

## Host integration

Each shown activity line is also emitted on the extension bus as `pi.events` channel `pi-summarize:activity`, with payload `{ sessionId, text, at, turn, source, toolCallIds }`. `sessionId` is the session that produced the line, so a host running several sessions can route by it.

Subagent children get their own bus unless the host passes one to their resource loader, so emits from a child do not reach the parent by default. Persisted history needs no bus: a child's session JSONL (the subagent `outputFile`) already contains its `pi-summarize` activity entries.

## Install

From git (once pushed):

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

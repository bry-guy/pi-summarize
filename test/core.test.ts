import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker, autoTitle, cleanLine, cleanTitle, fallbackLine, progressOf, resolveConfig, similarLine } from "../src/core.ts";

const flush = () => new Promise((r) => setImmediate(r));

/** Completion whose resolution the test controls. */
function deferred() {
	const calls: { prompt: string; signal: AbortSignal; resolve(t: string): void; reject(e: Error): void }[] = [];
	const complete = (prompt: string, signal: AbortSignal) =>
		new Promise<string>((resolve, reject) => calls.push({ prompt, signal, resolve, reject }));
	return { calls, complete };
}

function harness(complete: (p: string, s: AbortSignal) => Promise<string>, extra: { debounceMs?: number } = {}) {
	const shown: (string | undefined)[] = [];
	const records: { text: string; source: string; toolCallIds: string[] }[] = [];
	const tracker = new ActivityTracker({
		complete,
		show: (t) => shown.push(t),
		record: (r) => records.push(r),
		heartbeatMs: 0,
		...extra,
	});
	return { tracker, shown, records };
}

describe("resolveConfig", () => {
	it("defaults: session model, thinking off, both features on", () => {
		assert.deepEqual(resolveConfig({}, {}), { model: undefined, thinking: "off", activity: true, title: true });
	});

	it("reads settings.json key and lets env override it", () => {
		const settings = { "pi-summarize": { model: "anthropic/claude-haiku-5-5", thinking: "low", title: false } };
		assert.deepEqual(resolveConfig(settings, {}), {
			model: "anthropic/claude-haiku-5-5",
			thinking: "low",
			activity: true,
			title: false,
		});
		const env = { PI_SUMMARIZE_MODEL: "openai/x", PI_SUMMARIZE_TITLE: "1", PI_SUMMARIZE_ACTIVITY: "false" };
		assert.deepEqual(resolveConfig(settings, env), { model: "openai/x", thinking: "low", activity: false, title: true });
	});

	it("ignores an invalid thinking level", () => {
		assert.equal(resolveConfig({ "pi-summarize": { thinking: "turbo" } }, {}).thinking, "off");
	});
});

describe("fallbackLine", () => {
	it("describes the tool in present-progressive form", () => {
		assert.equal(fallbackLine({ name: "read", args: { path: "/src/lib/files.js" } }), "Reading files.js…");
		assert.equal(fallbackLine({ name: "bash", args: { command: "npm test" } }), "Running npm test…");
		assert.equal(fallbackLine({ name: "edit", args: { file_path: "a/b.ts" } }), "Editing b.ts…");
		assert.equal(fallbackLine({ name: "grep", args: { pattern: "TODO" } }), "Searching TODO…");
		assert.equal(fallbackLine({ name: "custom_thing" }), "Running custom_thing…");
		assert.equal(fallbackLine(undefined), "Thinking…");
	});
});

describe("cleanLine", () => {
	it("keeps one short line and strips quotes/trailing period", () => {
		assert.equal(cleanLine('"Checking the sync adapter…"\nextra'), "Checking the sync adapter…");
		assert.equal(cleanLine("Running the tests."), "Running the tests");
	});

	it("rejects empty or over-long output so the fallback is used", () => {
		assert.equal(cleanLine("   "), undefined);
		assert.equal(cleanLine("one two three four five six seven eight nine ten eleven twelve thirteen"), undefined);
	});
});

describe("ActivityTracker", () => {
	it("tool start summarizes immediately and records the model line with its tool call ids", async () => {
		const d = deferred();
		const { tracker, shown, records } = harness(d.complete);
		tracker.begin("fix sync");
		tracker.toolStart("t1", "read", { path: "src/sync.ts" });
		assert.equal(d.calls.length, 1);
		assert.match(d.calls[0].prompt, /User asked: fix sync/);
		d.calls[0].resolve("Checking the sync adapter…");
		await flush();
		assert.deepEqual(shown, ["Checking the sync adapter…"]);
		assert.equal(records[0].source, "model");
		assert.deepEqual(records[0].toolCallIds, ["t1"]);
	});

	it("falls back to a deterministic line when the model fails", async () => {
		const d = deferred();
		const { tracker, shown, records } = harness(d.complete);
		tracker.toolStart("t1", "bash", { command: "npm test" });
		d.calls[0].reject(new Error("boom"));
		await flush();
		assert.deepEqual(shown, ["Running npm test…"]);
		assert.equal(records[0].source, "fallback");
	});

	it("falls back when the call exceeds the timeout", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const neverEnds = (_p: string, signal: AbortSignal) =>
			new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
		const { tracker, shown } = harness(neverEnds);
		tracker.toolStart("t1", "read", { path: "/a/files.js" });
		t.mock.timers.tick(10_000);
		await flush();
		assert.deepEqual(shown, ["Reading files.js…"]);
	});

	it("drops a stale in-flight result when a newer call starts", async () => {
		const d = deferred();
		const { tracker, shown } = harness(d.complete);
		tracker.toolStart("t1", "read", { path: "a.ts" });
		tracker.toolStart("t2", "bash", { command: "npm test" });
		assert.equal(d.calls[0].signal.aborted, true);
		d.calls[0].resolve("Stale line");
		d.calls[1].resolve("Running the suite");
		await flush();
		assert.deepEqual(shown, ["Running the suite"]);
	});

	it("debounces text deltas into one call", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const d = deferred();
		const { tracker } = harness(d.complete);
		tracker.begin("q");
		tracker.textDelta("a");
		tracker.textDelta("b");
		tracker.thinkingDelta("c");
		t.mock.timers.tick(1999);
		assert.equal(d.calls.length, 0);
		t.mock.timers.tick(1);
		assert.equal(d.calls.length, 1);
	});

	it("stop() cancels the pending timer, aborts in-flight work, and restores the default line", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const d = deferred();
		const { tracker, shown } = harness(d.complete);
		tracker.textDelta("a");
		t.mock.timers.tick(2000);
		tracker.stop();
		assert.equal(d.calls[0].signal.aborted, true);
		d.calls[0].resolve("Late line");
		await flush();
		assert.deepEqual(shown, [undefined]);
	});

	it("does not re-show an identical line", async () => {
		const d = deferred();
		const { tracker, shown } = harness(d.complete);
		tracker.toolStart("t1", "read", { path: "a.ts" });
		d.calls[0].resolve("Reading a.ts");
		await flush();
		tracker.toolStart("t2", "read", { path: "a.ts" });
		d.calls[1].resolve("Reading a.ts");
		await flush();
		assert.deepEqual(shown, ["Reading a.ts"]);
	});
});

describe("autoTitle", () => {
	const base = () => {
		const state = { name: undefined as string | undefined, recorded: [] as unknown[] };
		const calls: string[] = [];
		return {
			state,
			calls,
			opts: {
				hasReply: true,
				alreadyTitled: false,
				getName: () => state.name,
				setName: (n: string) => (state.name = n),
				record: (e: unknown) => state.recorded.push(e),
				complete: async (p: string) => {
					calls.push(p);
					return '"Fix Sync Adapter."';
				},
				firstUser: "fix the sync adapter",
				firstAssistant: "On it.",
			},
		};
	};

	it("names an unnamed session after the first reply and records it as auto", async () => {
		const b = base();
		assert.equal(await autoTitle(b.opts), "Fix Sync Adapter");
		assert.equal(b.state.name, "Fix Sync Adapter");
		assert.equal(b.state.recorded.length, 1);
		assert.deepEqual(b.state.recorded[0], { kind: "title", text: "Fix Sync Adapter", auto: true, at: (b.state.recorded[0] as { at: number }).at });
	});

	it("does nothing before a reply, when already titled, or when a name exists", async () => {
		for (const patch of [{ hasReply: false }, { alreadyTitled: true }, { getName: () => "My name" }]) {
			const b = base();
			await autoTitle({ ...b.opts, ...patch });
			assert.equal(b.calls.length, 0);
			assert.equal(b.state.name, undefined);
		}
	});

	it("never overwrites a name the user sets while the title call runs", async () => {
		const b = base();
		b.opts.complete = async () => {
			b.state.name = "User name";
			return "Auto Title";
		};
		assert.equal(await autoTitle(b.opts), undefined);
		assert.equal(b.state.name, "User name");
	});

	it("fails silently when the model call throws", async () => {
		const b = base();
		b.opts.complete = async () => {
			throw new Error("no auth");
		};
		assert.equal(await autoTitle(b.opts), undefined);
		assert.equal(b.state.name, undefined);
		assert.equal(b.state.recorded.length, 0);
	});
});

describe("cleanTitle", () => {
	it("keeps at most four words", () => {
		assert.equal(cleanTitle("Refactor the big sync adapter module"), "Refactor the big sync");
		assert.equal(cleanTitle("**Sync Fix**"), "Sync Fix");
	});
});

describe("similarLine", () => {
	it("treats near-duplicate narration as the same", () => {
		assert.equal(similarLine("Tracing tool_execution_start events in the pi SDK", "Tracing tool_execution_start events in pi SDK"), true);
		assert.equal(similarLine("Reading files.js", "Running npm test"), false);
		assert.equal(similarLine(undefined, "Reading files.js"), false);
	});
});

describe("subagent progress", () => {
	it("reads pi-subagents activity and ignores spinner-only updates", () => {
		const a = progressOf({ details: { activity: "reading real.js", toolUses: 3, spinnerFrame: 1 } });
		assert.equal(a, "reading real.js · 3 tool uses");
		assert.equal(progressOf({ content: [{ type: "text", text: "line1\nok 5 tests" }] }), "line1 ok 5 tests");
		assert.equal(progressOf(undefined), undefined);
	});

	it("feeds subagent progress into the prompt and the fallback", async () => {
		const d = deferred();
		const { tracker, shown } = harness(d.complete, { debounceMs: 10 });
		tracker.toolStart("t1", "Agent", { description: "Explore busy line" });
		d.calls[0].reject(new Error("x"));
		await flush();
		assert.equal(shown.at(-1), "Subagent: Explore busy line…");
		tracker.toolUpdate({ details: { activity: "grep busy", toolUses: 4 } });
		tracker.toolUpdate({ details: { activity: "grep busy", toolUses: 4 } });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(d.calls.length, 2);
		assert.match(d.calls[1].prompt, /grep busy · 4 tool uses/);
		d.calls[1].reject(new Error("x"));
		await flush();
		assert.equal(shown.at(-1), "Subagent: Explore busy line: grep busy · 4 tool uses");
		tracker.stop();
	});

	it("names background waits", () => {
		assert.equal(fallbackLine({ name: "get_subagent_result", args: {} }), "Waiting on a subagent…");
	});
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker, autoTitle, cleanLine, cleanTitle, fallbackLine, formatRunLabel, progressLine, resolveConfig, similarLine, withElapsed } from "../src/core.ts";

const flush = () => new Promise((r) => setImmediate(r));

/** Completion whose resolution the test controls. */
function deferred() {
	const calls: { prompt: string; signal: AbortSignal; resolve(t: string): void; reject(e: Error): void }[] = [];
	const complete = (prompt: string, signal: AbortSignal) =>
		new Promise<string>((resolve, reject) => calls.push({ prompt, signal, resolve, reject }));
	return { calls, complete };
}

function harness(complete: (p: string, s: AbortSignal) => Promise<string>, extra: { debounceMs?: number; stepWaitMs?: number; firstDebounceMs?: number } = {}) {
	const shown: (string | undefined)[] = [];
	const records: { text: string; source: string; toolCallIds: string[] }[] = [];
	const merged: { text: string; toolCallIds: string[] }[] = [];
	const tracker = new ActivityTracker({
		complete,
		show: (t) => shown.push(t),
		record: (r) => (r.continues ? merged : records).push(r),
		heartbeatMs: 0,
		...extra,
	});
	return { tracker, shown, records, merged };
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

describe("cleanLine trailing dots", () => {
	it("strips trailing dots", () => {
		assert.equal(cleanLine("Reading files..."), "Reading files");
	});
});

describe("fallbackLine", () => {
	it("describes the tool in present-progressive form", () => {
		assert.equal(fallbackLine({ name: "read", args: { path: "/src/lib/files.js" } }), "Reading files.js…");
		assert.equal(fallbackLine({ name: "bash", args: { command: "npm test" } }), "Working…");
		assert.equal(fallbackLine({ name: "grep", args: { pattern: "a very long search pattern for things" } }), "Searching a very long search pattern…");
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
		assert.equal(records.length, 0); // breadcrumbs wait for the step to end
		await tracker.turnEnd();
		assert.equal(records[0].source, "model");
		assert.deepEqual(records[0].toolCallIds, ["t1"]);
	});

	it("falls back to a deterministic line when the model fails", async () => {
		const d = deferred();
		const { tracker, shown, records } = harness(d.complete);
		tracker.toolStart("t1", "bash", { command: "npm test" });
		d.calls[0].reject(new Error("boom"));
		await flush();
		assert.deepEqual(shown, [], "a generic fallback leaves the bare spinner");
		await tracker.turnEnd();
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
		const { tracker } = harness(d.complete, { firstDebounceMs: 2000 });
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

	it("records one breadcrumb per step; a tool-only step with the same goal merges", async () => {
		const d = deferred();
		const { tracker, records, shown, merged } = harness(d.complete, { stepWaitMs: 50 });
		tracker.turnStart(0);
		tracker.textDelta("Profile the remainder:");
		tracker.toolStart("t1", "bash", {});
		assert.match(d.calls[0].prompt, /lead-in for this step: Profile the remainder/);
		d.calls[0].resolve("Profiling the remaining latency");
		await tracker.turnEnd();
		tracker.turnStart(1); // tool-only step, same goal
		tracker.toolStart("t2", "bash", {});
		assert.match(d.calls[1].prompt, /Previous step: Profiling the remaining latency/);
		d.calls[1].resolve("SAME");
		await tracker.turnEnd();
		tracker.turnStart(2); // new lead-in: always its own breadcrumb
		tracker.textDelta("Now skip re-render when state is unchanged:");
		tracker.toolStart("t3", "edit", {});
		d.calls[2].resolve("Skipping re-renders when state is unchanged");
		await tracker.turnEnd();
		assert.deepEqual(records.map((r) => r.text), ["Profiling the remaining latency", "Skipping re-renders when state is unchanged"]);
		assert.equal(shown.at(-1), undefined, "after a breadcrumb the live line returns to the spinner");
		assert.deepEqual(records[1].toolCallIds, ["t3"]);
		assert.deepEqual(merged.map((r) => [r.text, r.toolCallIds]), [["Profiling the remaining latency", ["t2"]]], "the merged step names its breadcrumb and tools");
	});

	it("the live line never repeats the breadcrumb just left", async () => {
		const d = deferred();
		const { tracker, shown } = harness(d.complete, { stepWaitMs: 50 });
		tracker.turnStart(0);
		tracker.textDelta("Check it:");
		tracker.toolStart("t1", "read", { path: "a.ts" });
		d.calls[0].resolve("Checking the config loader");
		await tracker.turnEnd();
		tracker.turnStart(1);
		tracker.toolStart("t2", "read", { path: "b.ts" });
		d.calls[1].resolve("Checking the config loader");
		await flush();
		assert.equal(shown.at(-1), undefined);
	});

	it("records the step's model line as its breadcrumb even when the display suppressed it", async () => {
		const d = deferred();
		const { tracker, records, shown } = harness(d.complete, { stepWaitMs: 50 });
		tracker.turnStart(0);
		tracker.textDelta("Check it:");
		tracker.toolStart("t1", "read", { path: "a.ts" });
		d.calls[0].resolve("Checking the config loader");
		await tracker.turnEnd();
		tracker.turnStart(1);
		tracker.textDelta("Now the other loader:");
		tracker.toolStart("t2", "read", { path: "b.ts" });
		d.calls[1].resolve("Checking the config loader");
		await tracker.turnEnd();
		assert.equal(shown.filter(Boolean).length, 1, "the repeat was not displayed");
		assert.deepEqual(records.map((r) => [r.text, r.source]), [["Checking the config loader", "model"]], "identical line merges, never a fallback");
	});

	it("a step's first summary fires sooner than later ones", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const d = deferred();
		const { tracker } = harness(d.complete, { firstDebounceMs: 800, debounceMs: 2000 });
		tracker.turnStart(0);
		tracker.thinkingDelta("hmm");
		t.mock.timers.tick(799);
		assert.equal(d.calls.length, 0);
		t.mock.timers.tick(1);
		assert.equal(d.calls.length, 1);
	});

	it("never records the step's thinking", async () => {
		const d = deferred();
		const { tracker, records } = harness(d.complete, { stepWaitMs: 20 });
		tracker.turnStart(0);
		tracker.thinkingDelta("private reasoning");
		tracker.toolStart("t1", "read", { path: "a/b.ts" });
		await tracker.turnEnd();
		assert.equal(records.length, 1);
		assert.ok(!JSON.stringify(records[0]).includes("private reasoning"));
	});

	it("turnEnd does not wait forever for a slow live line", async () => {
		const d = deferred();
		const { tracker, records } = harness(d.complete, { stepWaitMs: 20 });
		tracker.turnStart(0);
		tracker.toolStart("t1", "read", { path: "a/b.ts" });
		await tracker.turnEnd();
		assert.equal(records[0].text, "Reading b.ts…");
		assert.equal(records[0].source, "fallback");
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

describe("tool progress", () => {
	const part = (text: string) => ({ content: [{ type: "text", text }] });

	it("takes the last non-empty line without control characters", () => {
		assert.equal(progressLine("role_agent", part("starting\n\x1b[32mr/dev: Fixing tests\x1b[0m · 6m 20s\n\n")), "r/dev: Fixing tests · 6m 20s");
		assert.equal(progressLine("role_agent", part("10%\r50%\r\x07done 90%")), "done 90%");
		assert.equal(progressLine("role_agent", part(`${"old line\n".repeat(5000)}r/dev: newest`)), "r/dev: newest");
	});

	it("only for allowlisted tools, never without text", () => {
		assert.equal(progressLine("bash", part("npm test\nok 1")), undefined);
		assert.equal(progressLine("subagent", part("3 tool uses...")), undefined);
		assert.equal(progressLine("role_agent", { content: [{ type: "image" }] }), undefined);
		assert.equal(progressLine("role_agent", undefined), undefined);
		assert.equal(progressLine("role_agent", part("\n \n")), undefined);
	});

	it("caps at ~90 characters and keeps a trailing elapsed time", () => {
		const long = `r/dev: ${"word ".repeat(40)}· 12m 05s`;
		const line = progressLine("role_agent", part(long))!;
		assert.ok(line.length <= 90, line);
		assert.match(line, /… · 12m 05s$/);
		assert.ok(progressLine("role_agent", part("y".repeat(200)))!.length <= 90);
	});

	it("adds the elapsed time only when the line has none", () => {
		assert.equal(withElapsed("Downloading 40%", 42), "Downloading 40% · 42s");
		assert.equal(withElapsed("r/dev: running · 6m 20s", 42), "r/dev: running · 6m 20s");
	});

	it("shows while the tool runs and the normal line returns at its end; nothing is recorded", async () => {
		const { calls, complete } = deferred();
		const { tracker, shown, records } = harness(complete);
		tracker.toolStart("t1", "role_agent", { role: "r/dev" });
		calls[0]!.resolve("Delegating the fix to a role");
		await flush();
		assert.equal(shown.at(-1), "Delegating the fix to a role");
		tracker.toolUpdate("t1", "role_agent", part("r/dev: Fixing tests · 1m 05s"));
		assert.equal(shown.at(-1), "r/dev: Fixing tests · 1m 05s");
		tracker.toolUpdate("t1", "bash", part("raw log"));
		assert.equal(shown.at(-1), "r/dev: Fixing tests · 1m 05s");
		tracker.toolEnd("t1");
		assert.equal(shown.at(-1), "Delegating the fix to a role");
		assert.equal(records.length, 0);
		tracker.stop();
	});
});

it("formats finished run summary labels", () => {
	assert.equal(formatRunLabel(400, 1), "Worked · 1 step");
	assert.equal(formatRunLabel(14_200, 4), "Worked 14s · 4 steps");
	assert.equal(formatRunLabel(125_000, 7), "Worked 2m 5s · 7 steps");
});

it("a subagent tool's progress leaves the summarized line alone", async () => {
	const { calls, complete } = deferred();
	const { tracker, shown } = harness(complete);
	tracker.toolStart("s1", "subagent", { prompt: "explore" });
	calls[0]!.resolve("Exploring the sync code");
	await flush();
	const before = shown.length;
	tracker.toolUpdate("s1", "subagent", { content: [{ type: "text", text: "4 tool uses..." }] });
	tracker.toolEnd("s1");
	assert.equal(shown.length, before);
	assert.equal(shown.at(-1), "Exploring the sync code");
	tracker.stop();
});

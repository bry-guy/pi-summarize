import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fake pi runtime + mocked model registry; exercises the real extension entry point.
const settingsDir = mkdtempSync(join(tmpdir(), "pi-summarize-"));
writeFileSync(
	join(settingsDir, "settings.json"),
	JSON.stringify({ "pi-summarize": { model: "anthropic/claude-haiku-5-5", thinking: "low" } }),
);
process.env.PI_CODING_AGENT_DIR = settingsDir;
delete process.env.PI_SUMMARIZE_MODEL;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("extension wiring", () => {
	let handlers: Record<string, (event: any, ctx: any) => Promise<void>>;
	let appended: { type: string; data: any }[];
	let names: string[];
	let streamCalls: { provider: string; id: string; reasoning?: string; prompt: string }[];
	let working: (string | undefined)[];
	let hiddenThinkingLabels: (string | undefined)[];
	let emitted: { channel: string; payload: any }[];
	let entryRenderer: ((entry: any, opts: { expanded: boolean }, theme: any) => any) | undefined;
	let sessionName: string | undefined;
	let ctx: any;

	before(async () => {
		const mod = await import("../extensions/index.ts");
		handlers = {};
		const pi = {
			on: (name: string, fn: any) => (handlers[name] = fn),
			events: { emit: (channel: string, payload: any) => emitted.push({ channel, payload }) },
			registerEntryRenderer: (_type: string, fn: any) => (entryRenderer = fn),
			registerToolRenderer: () => {},
			appendEntry: (type: string, data: any) => appended.push({ type, data }),
			setSessionName: (n: string) => {
				sessionName = n;
				names.push(n);
			},
			getSessionName: () => sessionName,
		};
		mod.default(pi as any);
	});

	function reset(name?: string) {
		appended = [];
		names = [];
		streamCalls = [];
		working = [];
		hiddenThinkingLabels = [];
		emitted = [];
		sessionName = name;
		ctx = {
			hasUI: true,
			model: { provider: "openai", id: "gpt-session" },
			ui: {
				setWorkingMessage: (m?: string) => working.push(m),
				notify: () => {},
				setHiddenThinkingLabel: (l?: string) => hiddenThinkingLabels.push(l),
			},
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
				hasConfiguredAuth: () => true,
				streamSimple: (model: any, context: any, opts: any) => {
					const prompt = context.messages[0].content[0].text as string;
					streamCalls.push({ provider: model.provider, id: model.id, reasoning: opts.reasoning, prompt });
					const text = prompt.includes("2-4 word title") ? '"Fix Sync Adapter."' : "Checking the sync adapter…";
					return {
						async *[Symbol.asyncIterator]() {
							yield { type: "done", message: { content: [{ type: "text", text }] } };
						},
					};
				},
			},
		};
	}

	it("summarizes tool calls into the working line, persists them, and titles the session", async () => {
		reset();
		await handlers.session_start({ reason: "startup" }, ctx);
		await handlers.before_agent_start({ type: "before_agent_start", prompt: "fix sync" }, ctx);
		await handlers.tool_execution_start(
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/sync.ts" } },
			ctx,
		);
		await sleep(20);
		await handlers.turn_end({ type: "turn_end" }, ctx);

		assert.deepEqual(hiddenThinkingLabels, [""], "hides the collapsed Thinking... label by default");
		assert.equal(streamCalls[0].provider, "anthropic");
		assert.equal(streamCalls[0].id, "claude-haiku-5-5");
		assert.equal(streamCalls[0].reasoning, "low");
		assert.deepEqual(working, ["Checking the sync adapter…", undefined], "line shown, then cleared once the step leaves its breadcrumb");
		assert.deepEqual(
			emitted.filter((e) => e.channel === "pi-summarize:working").map((e) => e.payload.text),
			["Checking the sync adapter…", null],
		);
		assert.equal(emitted.some((e) => e.channel === "pi-summarize:activity" && e.payload?.data?.text === "Checking the sync adapter…"), true);
		const activity = appended.find((e) => e.data.kind === "activity");
		assert.equal(activity?.type, "pi-summarize");
		assert.deepEqual(activity?.data.toolCallIds, ["t1"]);

		await handlers.agent_end({ type: "agent_end", messages: [] }, ctx);
		const run = appended.find((e) => e.data.kind === "run");
		assert.equal(run?.type, "pi-summarize");
		assert.equal(run?.data.text, undefined, "run entry omits text so pi-web summaryRecord ignores it");
		assert.equal(run?.data.steps, 1);
		assert.equal(run?.data.items.length, 1);
		assert.equal(run?.data.items[0].text, "Checking the sync adapter…");

		const plainTheme = { fg: (_color: string, text: string) => text };
		assert.equal(entryRenderer?.({ data: activity?.data }, { expanded: false }, plainTheme), undefined);
		const collapsed = entryRenderer?.({ data: run?.data }, { expanded: false }, plainTheme)?.render(120).join("\n") ?? "";
		assert.match(collapsed, /◆ Worked.*1 step/);
		assert.doesNotMatch(collapsed, /Checking the sync adapter/);
		const expanded = entryRenderer?.({ data: run?.data }, { expanded: true }, plainTheme)?.render(120).join("\n") ?? "";
		assert.match(expanded, /◆ Worked.*1 step/);
		assert.match(expanded, /Checking the sync adapter/);
		assert.match(expanded, /read\(/);

		ctx.sessionManager.getBranch = () => [
			{ type: "message", message: { role: "user", content: "fix sync" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "On it." }] } },
		];
		await handlers.agent_settled({ type: "agent_settled", aborted: false }, ctx);

		assert.equal(working.at(-1), undefined, "default working line restored");
		assert.deepEqual(names, ["Fix Sync Adapter"]);
		const title = appended.find((e) => e.data.kind === "title");
		assert.equal(title?.data.auto, true);
	});

	it("never renames a session the user already named", async () => {
		reset("My manual name");
		await handlers.session_start({ reason: "resume" }, ctx);
		ctx.sessionManager.getBranch = () => [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "assistant", content: "yo" } },
		];
		await handlers.agent_settled({ type: "agent_settled", aborted: false }, ctx);
		await sleep(20);
		assert.deepEqual(names, []);
		assert.equal(streamCalls.filter((c) => c.prompt.includes("2-4 word title")).length, 0);
	});
});

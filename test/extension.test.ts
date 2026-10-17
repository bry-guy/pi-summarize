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
	let emitted: { channel: string; data: any }[];
	let sessionName: string | undefined;
	let ctx: any;

	before(async () => {
		const mod = await import("../extensions/index.ts");
		handlers = {};
		const pi = {
			on: (name: string, fn: any) => (handlers[name] = fn),
			registerEntryRenderer: () => {},
			registerToolRenderer: () => {},
			appendEntry: (type: string, data: any) => appended.push({ type, data }),
			events: { emit: (channel: string, data: any) => emitted.push({ channel, data }) },
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
		emitted = [];
		sessionName = name;
		ctx = {
			hasUI: true,
			model: { provider: "openai", id: "gpt-session" },
			ui: { setWorkingMessage: (m?: string) => working.push(m), notify: () => {} },
			sessionManager: { getBranch: () => [], getSessionId: () => "child-session" },
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

		assert.equal(streamCalls[0].provider, "anthropic");
		assert.equal(streamCalls[0].id, "claude-haiku-5-5");
		assert.equal(streamCalls[0].reasoning, "low");
		assert.deepEqual(working, ["Checking the sync adapter…"]);
		const activity = appended.find((e) => e.data.kind === "activity");
		assert.equal(activity?.type, "pi-summarize");
		assert.deepEqual(activity?.data.toolCallIds, ["t1"]);
		const shown = emitted.find((e) => e.channel === "pi-summarize:activity");
		assert.equal(shown?.data.sessionId, "child-session");
		assert.equal(shown?.data.text, "Checking the sync adapter…");
		assert.deepEqual(shown?.data.toolCallIds, ["t1"]);

		await handlers.agent_end({ type: "agent_end", messages: [] }, ctx);
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

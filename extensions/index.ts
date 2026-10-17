import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActivityTracker, autoTitle, resolveConfig, type SummarizeConfig } from "../src/core.ts";

type Ctx = ExtensionContext;
type Context = Parameters<Ctx["modelRegistry"]["streamSimple"]>[1];
type Content = { type?: string; text?: string };

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? (content as Content[])
					.filter((c) => c.type === "text" && typeof c.text === "string")
					.map((c) => c.text)
					.join("\n")
			: "";

/** Bus channel for each shown activity line. Hosts such as subagent runners listen here. */
const ACTIVITY_CHANNEL = "pi-summarize:activity";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

function loadSettings(): unknown {
	try {
		return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	} catch {
		return {};
	}
}

/** Configured "provider/id" model, or the session's current model when unset. */
function resolveModel(ctx: Ctx, spec: string | undefined) {
	if (!spec) return ctx.model;
	const slash = spec.indexOf("/");
	return slash > 0 ? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
}

/** One side-model call. Rejects when no usable model exists, the call fails, or the signal aborts. */
async function complete(ctx: Ctx, cfg: SummarizeConfig, prompt: string, signal: AbortSignal, maxTokens: number) {
	const model = resolveModel(ctx, cfg.model);
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error("no usable summary model");
	const context: Context = {
		messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
	};
	const stream = ctx.modelRegistry.streamSimple(model, context, {
		...(cfg.thinking === "off" ? {} : { reasoning: cfg.thinking }),
		signal,
		maxTokens,
	});
	for await (const event of stream) {
		if (event.type === "done") return textOf(event.message.content);
		if (event.type === "error") throw new Error("summary model error");
	}
	throw new Error("summary stream ended without a result");
}

export default function (pi: ExtensionAPI) {
	let live: Ctx | undefined; // latest context; the one captured at session_start can go stale
	let cfg: SummarizeConfig = resolveConfig({}, {});
	let tracker: ActivityTracker | undefined;
	let titling = false;

	pi.on("session_start", async (_event, ctx) => {
		live = ctx;
		cfg = resolveConfig(loadSettings(), process.env);
		tracker?.stop();
		const sessionId = ctx.sessionManager.getSessionId();
		tracker = new ActivityTracker({
			complete: (prompt, signal) => complete(live!, cfg, prompt, signal, 60),
			show: (text) => live?.ui.setWorkingMessage(text),
			record: (entry) => {
				pi.appendEntry("pi-summarize", { kind: "activity", ...entry });
				pi.events.emit(ACTIVITY_CHANNEL, { sessionId, ...entry });
			},
		});
		if (cfg.model && !resolveModel(ctx, cfg.model) && ctx.hasUI) {
			ctx.ui.notify(`pi-summarize: model "${cfg.model}" not found; using fallback lines`, "warning");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		live = ctx;
		if (cfg.activity) tracker?.begin("prompt" in event ? event.prompt : undefined);
	});

	pi.on("turn_start", async (event, ctx) => {
		live = ctx;
		if (cfg.activity) tracker?.turnStart(event.turnIndex);
	});

	pi.on("message_update", async (event, ctx) => {
		live = ctx;
		if (!cfg.activity) return;
		const ev = event.assistantMessageEvent;
		if (ev.type === "thinking_delta") tracker?.thinkingDelta(ev.delta);
		if (ev.type === "text_delta") tracker?.textDelta(ev.delta);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		live = ctx;
		if (cfg.activity) tracker?.toolStart(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		live = ctx;
		if (cfg.activity) tracker?.toolEnd();
	});

	pi.on("agent_end", async (_event, ctx) => {
		live = ctx;
		if (cfg.activity) tracker?.stop();
	});

	// agent_settled, not agent_end: print mode can exit right after agent_end, and this must finish first.
	pi.on("agent_settled", async (_event, ctx) => {
		live = ctx;
		if (!cfg.title || titling) return;

		const branch = ctx.sessionManager.getBranch();
		const alreadyTitled = branch.some(
			(e) => e.type === "custom" && e.customType === "pi-summarize" && (e.data as { kind?: string })?.kind === "title",
		);
		const messages = branch.flatMap((e) => (e.type === "message" ? [e.message as { role?: string; content?: unknown }] : []));
		const firstUser = messages.find((m) => m.role === "user");
		const firstAssistant = messages.find((m) => m.role === "assistant");

		titling = true;
		try {
			await autoTitle({
				hasReply: Boolean(firstAssistant),
				alreadyTitled,
				getName: () => pi.getSessionName(),
				setName: (name) => pi.setSessionName(name),
				record: (entry) => pi.appendEntry("pi-summarize", entry),
				complete: (prompt) => complete(live!, cfg, prompt, AbortSignal.timeout(15_000), 30),
				firstUser: textOf(firstUser?.content),
				firstAssistant: textOf(firstAssistant?.content),
			});
		} catch {
			// titling is best-effort
		} finally {
			titling = false;
		}
	});

	pi.on("session_shutdown", async () => {
		tracker?.stop();
	});
}

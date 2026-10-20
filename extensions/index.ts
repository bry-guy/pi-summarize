import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
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

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

function loadSettings(): Record<string, unknown> {
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
	const options = { ...(cfg.thinking === "off" ? {} : { reasoning: cfg.thinking }), signal, maxTokens };
	const stream = ctx.modelRegistry.streamSimple(model, context, options);
	for await (const event of stream) {
		if (event.type === "done") return textOf(event.message.content);
		if (event.type === "error") throw new Error("summary model error");
	}
	throw new Error("summary stream ended without a result");
}

export default function (pi: ExtensionAPI) {
	registerRenderers(pi, () => cfg.activity);
	let live: Ctx | undefined; // latest context; the one captured at session_start can go stale
	let cfg: SummarizeConfig = resolveConfig({}, {});
	let tracker: ActivityTracker | undefined;
	let titling = false;

	pi.on("session_start", async (_event, ctx) => {
		live = ctx;
		cfg = resolveConfig(loadSettings(), process.env);
		tracker?.stop();
		tracker = new ActivityTracker({
			complete: (prompt, signal) => complete(live!, cfg, prompt, signal, 60),
			show: (text) => live?.ui.setWorkingMessage(text),
			record: (entry) => pi.appendEntry("pi-summarize", { kind: "activity", ...entry }),
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

	// Awaited so the breadcrumb lands where the step's hidden tool rows are, before the next step's text.
	pi.on("turn_end", async (_event, ctx) => {
		live = ctx;
		if (cfg.activity) await tracker?.turnEnd();
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

type Renderers = NonNullable<ReturnType<Parameters<ExtensionAPI["registerToolRenderer"]>[0]>>;
type Data = { kind?: string; text?: string; source?: string; thinking?: string; tools?: string[] };

/**
 * Collapsed (default): tool rows render nothing, so the summary lines stand in for them.
 * Expanded (Ctrl+O): tools render normally, and summaries show what they summarized.
 */
function registerRenderers(pi: ExtensionAPI, enabled: () => boolean) {
	pi.registerEntryRenderer<Data>("pi-summarize", (entry, { expanded }, theme) => {
		const d = entry.data;
		// undefined, not an empty component: pi adds a spacer line before every component it is given.
		if (d?.kind !== "activity" || !d.text || !enabled()) return undefined;
		if (d.source === "fallback" && !expanded) return undefined; // generic lines add nothing at a glance
		const box = new Box(1, 0);
		box.addChild(new Text(`${theme.fg("accent", "◆")} ${theme.fg("muted", d.text)}`, 0, 0));
		if (expanded) {
			if (d.thinking) box.addChild(new Text(theme.fg("dim", `  thinking: ${d.thinking.replace(/\s+/g, " ")}`), 0, 0));
			for (const t of d.tools ?? []) box.addChild(new Text(theme.fg("dim", `  ${t}`), 0, 0));
		}
		return box;
	});

	pi.registerToolRenderer((toolName, next): Renderers | undefined => {
		const inner = next();
		if (!enabled()) return inner;
		// renderShell "self" lets an empty render collapse the row to zero lines; when expanded we draw the shell ourselves.
		type Theme = Parameters<NonNullable<Renderers["renderCall"]>>[1];
		const shell = (child: unknown, theme: Theme, ctx: { isPartial: boolean; isError: boolean }) => {
			const box = new Box(1, 0, (t: string) => theme.bg(ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg", t));
			if (child) box.addChild(child as Text);
			return box;
		};
		return {
			renderShell: "self",
			renderCall(args, theme, ctx) {
				if (!ctx.expanded) return new Container();
				if (inner?.renderShell === "self") return inner.renderCall?.(args, theme, ctx) ?? new Container();
				return shell(inner?.renderCall?.(args, theme, { ...ctx, lastComponent: undefined }) ?? new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0), theme, ctx);
			},
			renderResult(result, opts, theme, ctx) {
				if (!ctx.expanded) return new Container();
				if (inner?.renderShell === "self") return inner.renderResult?.(result, opts, theme, ctx) ?? new Container();
				const text = (result.content as Content[] | undefined)?.filter((c) => c.type === "text").map((c) => c.text).join("\n");
				const child = inner?.renderResult ? inner.renderResult(result, opts, theme, { ...ctx, lastComponent: undefined }) : text ? new Text(theme.fg("toolOutput", text), 0, 0) : undefined;
				return shell(child, theme, ctx);
			},
		};
	});
}

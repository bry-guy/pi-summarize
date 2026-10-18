// Pure logic for pi-summarize: config, fallback lines, debounced activity tracker, auto-title rules.
// No pi runtime imports, so it runs under plain `node --test`.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SummarizeConfig {
	/** "provider/id". Undefined means the session's current model. */
	model?: string;
	thinking: ThinkingLevel;
	activity: boolean;
	title: boolean;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const flag = (value: unknown, fallback: boolean): boolean =>
	value === undefined || value === null ? fallback : !/^(0|false|off|no)$/i.test(String(value));

/** Env (PI_SUMMARIZE_*) wins over the "pi-summarize" key in settings.json. */
export function resolveConfig(settings: unknown, env: Record<string, string | undefined>): SummarizeConfig {
	const own = (settings as { "pi-summarize"?: Record<string, unknown> } | undefined)?.["pi-summarize"] ?? {};
	const model = env.PI_SUMMARIZE_MODEL ?? (typeof own.model === "string" ? own.model : undefined);
	const thinkingRaw = env.PI_SUMMARIZE_THINKING ?? own.thinking;
	const thinking = THINKING_LEVELS.find((level) => level === thinkingRaw) ?? "off";
	return {
		model: model?.trim() || undefined,
		thinking,
		activity: flag(env.PI_SUMMARIZE_ACTIVITY ?? own.activity, true),
		title: flag(env.PI_SUMMARIZE_TITLE ?? own.title, true),
	};
}

export interface ToolActivity {
	name: string;
	args?: Record<string, unknown>;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const clip = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:\u2026]+$/, "")}\u2026`;
};
const baseName = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/** Deterministic line used when the model is unavailable, slow, or fails. */
export function fallbackLine(tool?: ToolActivity): string {
	if (!tool) return "Thinking…";
	const args = tool.args ?? {};
	const path = str(args.path) ?? str(args.file_path) ?? str(args.file);
	const name = tool.name.toLowerCase();
	if (name === "bash") return "Working…"; // the command itself is noise; the model supplies the goal
	if (name === "read" && path) return `Reading ${baseName(path)}…`;
	if (name === "edit" && path) return `Editing ${baseName(path)}…`;
	if (name === "write" && path) return `Writing ${baseName(path)}…`;
	if (["grep", "find", "glob"].includes(name)) return `Searching ${clip(str(args.pattern) ?? path ?? "files", 30).replace(/…$/, "")}…`;
	if (name === "ls") return `Listing ${clip(path ?? "files", 30).replace(/…$/, "")}…`;
	return `Running ${tool.name}…`;
}

const words = (text: string): Set<string> =>
	new Set(text.toLowerCase().replace(/[^a-z0-9_\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2));

/** True when two lines say essentially the same thing (word overlap), so the newer one adds nothing. */
export function similarLine(a: string | undefined, b: string): boolean {
	if (!a) return false;
	const x = words(a);
	const y = words(b);
	if (!x.size || !y.size) return a.trim() === b.trim();
	let shared = 0;
	for (const w of x) if (y.has(w)) shared++;
	return shared / Math.min(x.size, y.size) >= 0.75;
}

/** Accept one short line; reject anything over 12 words so the fallback is used instead. */
export function cleanLine(raw: string): string | undefined {
	const line = raw
		.split("\n")
		.map((s) => s.trim())
		.find(Boolean)
		?.replace(/^["'`*#>\-\s]+|["'`*\s]+$/g, "")
		.replace(/\.+$/, "");
	if (!line || line.split(/\s+/).length > 12) return undefined;
	if (/^same$/i.test(line)) return "SAME";
	return clip(line, 80);
}

const tail = (text: string, max: number): string => (text.length > max ? text.slice(-max) : text);

export interface ActivityRecord {
	text: string;
	at: number;
	turn: number;
	source: "model" | "fallback";
	toolCallIds: string[];
	/** What the line summarized, for the expanded transcript view. */
	thinking?: string;
	tools?: string[];
}

export interface TrackerOptions {
	/** Calls the side model. Must reject on failure and honor the signal. */
	complete(prompt: string, signal: AbortSignal): Promise<string>;
	/** Shows a line in the working indicator; undefined restores the default. */
	show(text: string | undefined): void;
	record(entry: ActivityRecord): void;
	debounceMs?: number;
	timeoutMs?: number;
	/** How long turnEnd waits for the step's live line before using the fallback. */
	stepWaitMs?: number;
	/** While a tool runs with no new line, re-show the line with elapsed time this often. 0 disables. */
	heartbeatMs?: number;
}

export class ActivityTracker {
	private userPrompt?: string;
	private turn = 0;
	private tools: string[] = [];
	private lastTool?: ToolActivity;
	private text = "";
	private thinking = "";
	/** The current step (one model turn): its lead-in text, thinking and tool calls. */
	private step = { text: "", thinking: "", tools: [] as string[], ids: [] as string[] };
	private timer?: ReturnType<typeof setTimeout>;
	private inflight?: AbortController;
	private pending?: Promise<void>;
	private seq = 0;
	private last?: string;
	private lastTurn = -1;
	private lastSource: ActivityRecord["source"] = "fallback";
	/** Last recorded breadcrumb; survives across runs so a tool-only step can merge into it. */
	private crumb?: string;
	private stale = false;
	private toolSince?: number;
	private beat?: ReturnType<typeof setInterval>;

	private readonly opts: TrackerOptions;

	constructor(opts: TrackerOptions) {
		this.opts = opts;
	}

	/** New agent run: forget the previous run's activity. */
	begin(userPrompt?: string): void {
		this.userPrompt = userPrompt;
		this.tools = [];
		this.lastTool = undefined;
		this.text = "";
		this.thinking = "";
	}

	turnStart(turn: number): void {
		this.turn = turn;
		this.step = { text: "", thinking: "", tools: [], ids: [] };
	}

	thinkingDelta(delta: string): void {
		this.thinking = tail(this.thinking + delta, 400);
		this.step.thinking = tail(this.step.thinking + delta, 400);
		this.schedule();
	}

	textDelta(delta: string): void {
		this.text = tail(this.text + delta, 600);
		this.step.text = tail(this.step.text + delta, 600);
		this.schedule();
	}

	/** Tool calls are the most informative boundary, so they summarize immediately. */
	toolStart(toolCallId: string, name: string, args?: Record<string, unknown>): void {
		this.lastTool = { name, args };
		this.toolSince = Date.now();
		this.stale = true; // no heartbeat until this tool's line is decided
		this.startBeat();
		const call = `${name}(${clip(JSON.stringify(args ?? {}), 160)})`;
		this.tools = [...this.tools, call].slice(-4);
		this.step.tools.push(call);
		this.step.ids.push(toolCallId);
		this.kick();
	}

	toolEnd(): void {
		this.toolSince = undefined;
		this.schedule();
	}

	/**
	 * A step that ran tools ends: record one breadcrumb where its hidden tool rows sit.
	 * Waits briefly for the step's live line; a tool-only step with the same goal merges into the previous breadcrumb.
	 */
	async turnEnd(): Promise<void> {
		const step = this.step;
		const turn = this.turn;
		if (!step.ids.length) return;
		this.step = { text: "", thinking: "", tools: [], ids: [] };
		if (this.pending) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([this.pending, new Promise((r) => (timer = setTimeout(r, this.opts.stepWaitMs ?? 2500)))]);
			clearTimeout(timer);
		}
		const fresh = this.last !== undefined && this.lastTurn === turn;
		const line = fresh ? (this.last as string) : fallbackLine(this.lastTool);
		const source = fresh ? this.lastSource : "fallback";
		const leadIn = step.text.trim() !== "";
		if (this.crumb && (line === this.crumb || (!leadIn && (source === "fallback" || similarLine(this.crumb, line))))) return;
		this.crumb = line;
		this.opts.record({ text: line, at: Date.now(), turn, source, toolCallIds: step.ids, thinking: step.thinking.trim() || undefined, tools: step.tools });
	}

	/** Keeps the line visibly alive during long tools: same text plus elapsed seconds, display only. */
	private startBeat(): void {
		const every = this.opts.heartbeatMs ?? 5000;
		if (!every || this.beat) return;
		this.beat = setInterval(() => {
			if (!this.toolSince || !this.last || this.stale) return;
			const secs = Math.round((Date.now() - this.toolSince) / 1000);
			if (secs >= 5) this.opts.show(`${this.last} · ${secs}s`);
		}, every);
		(this.beat as { unref?: () => void }).unref?.();
	}

	/** Agent run ended: drop pending work, cancel in-flight calls, restore the default line. */
	stop(): void {
		this.clearTimer();
		if (this.beat) clearInterval(this.beat);
		this.beat = undefined;
		this.toolSince = undefined;
		this.inflight?.abort();
		this.inflight = undefined;
		this.seq++;
		this.last = undefined;
		this.opts.show(undefined);
	}

	/** Max-wait debounce: the first event in a window arms one flush, so long streams still update. */
	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => this.kick(), this.opts.debounceMs ?? 2000);
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private kick(): void {
		this.pending = this.flush();
	}

	/** Updates the live working line only; breadcrumbs are recorded per step in turnEnd. */
	private async flush(): Promise<void> {
		this.clearTimer();
		const seq = ++this.seq;
		this.inflight?.abort();
		const ctl = new AbortController();
		this.inflight = ctl;
		const timeout = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000);
		let text: string | undefined;
		try {
			text = cleanLine(await this.opts.complete(this.prompt(), ctl.signal));
		} catch {
			text = undefined; // fail silently to the fallback below
		} finally {
			clearTimeout(timeout);
		}
		if (seq !== this.seq) return; // a newer flush or stop() superseded this one
		this.stale = false;
		this.inflight = undefined;
		const same = text?.toUpperCase() === "SAME";
		this.lastTurn = this.turn;
		if (same && this.last) return; // the current line still describes this step
		const line = text && !same ? text : fallbackLine(this.lastTool);
		this.lastSource = text && !same ? "model" : "fallback";
		if (line === this.last || (text && similarLine(this.last, line))) return;
		this.last = line;
		this.opts.show(line);
	}

	private prompt(): string {
		const leadIn = this.step.text.trim();
		return [
			"You narrate the GOAL of a coding agent's current step, not the command it runs.",
			"Infer intent from the agent's lead-in for this step, the user's request, and the step's tool calls.",
			"Never name a shell command, flag, or tool; say why it is being run.",
			'Good: "Checking why the sync test fails", "Finding where titles get set", "Skipping re-renders when state is unchanged".',
			'Bad: "Running git status", "Running bash", "Reading core.ts".',
			"Reply with ONE line, at most 12 words, present-progressive.",
			"No quotes, no preamble, no trailing period. Output only the line.",
			this.crumb ? `Previous step: ${this.crumb}. Describe what is new in this step; do not repeat it.` : "",
			this.last && !leadIn ? `Current line: ${this.last}\nIf it still describes the work, reply exactly SAME.` : "",
			"",
			"<context>",
			this.userPrompt ? `User asked: ${clip(this.userPrompt, 300)}` : "",
			leadIn ? `Agent's lead-in for this step: ${clip(leadIn, 400)}` : "",
			this.tools.length ? `Recent tool calls (latest last): ${this.tools.join("; ")}` : "",
			!leadIn && this.text.trim() ? `Assistant text tail: ${clip(this.text, 600)}` : "",
			this.thinking.trim() ? `Thinking tail: ${clip(this.thinking, 300)}` : "",
			"</context>",
		]
			.filter(Boolean)
			.join("\n");
	}
}

/** Strip quotes/punctuation, keep 2–4 words. */
export function cleanTitle(raw: string): string | undefined {
	const line = raw
		.split("\n")
		.map((s) => s.trim())
		.find(Boolean)
		?.replace(/^["'`*#\s]+|["'`*.!?\s]+$/g, "");
	if (!line) return undefined;
	return clip(line.split(/\s+/).slice(0, 4).join(" "), 60);
}

export interface AutoTitleOptions {
	hasReply: boolean;
	/** True once pi-summarize has already named this session (see the "title" record). */
	alreadyTitled: boolean;
	getName(): string | undefined;
	setName(name: string): void;
	record(entry: { kind: "title"; text: string; auto: true; at: number }): void;
	complete(prompt: string): Promise<string>;
	firstUser?: string;
	firstAssistant?: string;
}

/** Names an unnamed session after its first reply. Never overwrites a name that exists before or during the call. */
export async function autoTitle(o: AutoTitleOptions): Promise<string | undefined> {
	if (!o.hasReply || o.alreadyTitled || o.getName()) return undefined;
	const prompt = [
		"Give a 2-4 word title for this coding session. Reply with only the title, no quotes.",
		"",
		`User: ${clip(o.firstUser ?? "", 500)}`,
		`Assistant: ${clip(o.firstAssistant ?? "", 500)}`,
	].join("\n");
	let title: string | undefined;
	try {
		title = cleanTitle(await o.complete(prompt));
	} catch {
		return undefined;
	}
	if (!title || o.getName()) return undefined;
	o.setName(title);
	o.record({ kind: "title", text: title, auto: true, at: Date.now() });
	return title;
}

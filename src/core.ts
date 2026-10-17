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
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const baseName = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/** Deterministic line used when the model is unavailable, slow, or fails. */
export function fallbackLine(tool?: ToolActivity): string {
	if (!tool) return "Thinking…";
	const args = tool.args ?? {};
	const path = str(args.path) ?? str(args.file_path) ?? str(args.file);
	const name = tool.name.toLowerCase();
	if (name === "bash") return `Running ${clip(str(args.command) ?? "command", 40)}…`;
	if (name === "read" && path) return `Reading ${baseName(path)}…`;
	if (name === "edit" && path) return `Editing ${baseName(path)}…`;
	if (name === "write" && path) return `Writing ${baseName(path)}…`;
	if (["grep", "find", "glob"].includes(name)) return `Searching ${clip(str(args.pattern) ?? path ?? "files", 30)}…`;
	if (name === "ls") return `Listing ${clip(path ?? "files", 30)}…`;
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

/** Accept one short line; reject anything over 8 words so the fallback is used instead. */
export function cleanLine(raw: string): string | undefined {
	const line = raw
		.split("\n")
		.map((s) => s.trim())
		.find(Boolean)
		?.replace(/^["'`*#>\-\s]+|["'`*\s]+$/g, "")
		.replace(/\.$/, "");
	if (!line || line.split(/\s+/).length > 8) return undefined;
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
}

export interface TrackerOptions {
	/** Calls the side model. Must reject on failure and honor the signal. */
	complete(prompt: string, signal: AbortSignal): Promise<string>;
	/** Shows a line in the working indicator; undefined restores the default. */
	show(text: string | undefined): void;
	record(entry: ActivityRecord): void;
	debounceMs?: number;
	timeoutMs?: number;
}

export class ActivityTracker {
	private userPrompt?: string;
	private turn = 0;
	private tools: string[] = [];
	private lastTool?: ToolActivity;
	private text = "";
	private thinking = "";
	private toolCallIds: string[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private inflight?: AbortController;
	private seq = 0;
	private last?: string;

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
		this.toolCallIds = [];
	}

	turnStart(turn: number): void {
		this.turn = turn;
	}

	thinkingDelta(delta: string): void {
		this.thinking = tail(this.thinking + delta, 400);
		this.schedule();
	}

	textDelta(delta: string): void {
		this.text = tail(this.text + delta, 600);
		this.schedule();
	}

	/** Tool calls are the most informative boundary, so they summarize immediately. */
	toolStart(toolCallId: string, name: string, args?: Record<string, unknown>): void {
		this.lastTool = { name, args };
		this.tools = [...this.tools, fallbackLine(this.lastTool).replace(/…$/, "")].slice(-4);
		this.toolCallIds.push(toolCallId);
		void this.flush();
	}

	toolEnd(): void {
		this.schedule();
	}

	/** Agent run ended: drop pending work, cancel in-flight calls, restore the default line. */
	stop(): void {
		this.clearTimer();
		this.inflight?.abort();
		this.inflight = undefined;
		this.seq++;
		this.last = undefined;
		this.opts.show(undefined);
	}

	/** Max-wait debounce: the first event in a window arms one flush, so long streams still update. */
	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => void this.flush(), this.opts.debounceMs ?? 2000);
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private async flush(): Promise<void> {
		this.clearTimer();
		const seq = ++this.seq;
		this.inflight?.abort();
		const ctl = new AbortController();
		this.inflight = ctl;
		const timeout = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000);
		const ids = [...this.toolCallIds];
		let text: string | undefined;
		try {
			text = cleanLine(await this.opts.complete(this.prompt(), ctl.signal));
		} catch {
			text = undefined; // fail silently to the fallback below
		} finally {
			clearTimeout(timeout);
		}
		if (seq !== this.seq) return; // a newer flush or stop() superseded this one
		this.inflight = undefined;
		const source = text ? "model" : "fallback";
		const line = text ?? fallbackLine(this.lastTool);
		if (line.toUpperCase() === "SAME" || similarLine(this.last, line)) return; // keep ids for the next line
		if (line === this.last) return;
		this.last = line;
		this.toolCallIds = [];
		this.opts.show(line);
		this.opts.record({ text: line, at: Date.now(), turn: this.turn, source, toolCallIds: ids });
	}

	private prompt(): string {
		return [
			"You narrate what a coding agent is doing right now.",
			"Reply with ONE line, at most 8 words, present-progressive, e.g. \"Checking the sync adapter…\".",
			"No quotes, no preamble, no trailing period. Output only the line.",
			this.last ? `Current line: ${this.last}\nIf it still describes the work, reply exactly SAME.` : "",
			"",
			"<context>",
			this.userPrompt ? `User asked: ${clip(this.userPrompt, 300)}` : "",
			this.tools.length ? `Recent tools: ${this.tools.join("; ")}` : "",
			this.text.trim() ? `Assistant text tail: ${clip(this.text, 600)}` : "",
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

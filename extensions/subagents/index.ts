/**
 * Minimal subagents extension.
 *
 * Registers a single `subagent` tool with three agents: scout, researcher, worker.
 * Supports single and parallel execution. Output is verbal only (no file handoff).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    getMarkdownTheme,
    parseFrontmatter,
    truncateHead,
    withFileMutationQueue,
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    Markdown,
    Spacer,
    Text,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Types ──────────────────────────────────────────────────────────────

export interface AgentConfig {
    name: string;
    description: string;
    /**
     * Tool whitelist for this agent. Supports a wildcard `"*"` entry that
     * grants access to every known tool. When `"*"` is present, the optional
     * `tools_exclude` field can blacklist specific tools from that set.
     */
    tools: string[];
    /**
     * Tools to exclude when `tools` includes the wildcard `"*"`. Ignored when
     * `tools` is a conventional whitelist (no `"*"` entry).
     */
    tools_exclude?: string[];
    model: string;
    thinking: string;
    systemPrompt: string;
    filePath: string;
    /**
     * If this agent has the `subagent` tool, restrict which agents it may spawn.
     * Passed to the child pi process via `PI_SUBAGENT_ALLOWED` so the child's
     * subagents extension filters its own registry before exposing it to the LLM.
     * `undefined` means no restriction (child sees every registered agent).
     */
    subagentAgents?: string[];
}

interface ToolEvent {
    tool: string;
    args: string;
    /** Matches the producing tool_execution_start/update/end event. */
    toolCallId?: string;
    /**
     * "running" while between tool_execution_start and tool_execution_end; flipped
     * to "done" on end. We store every in-flight call in recentTools (keyed by
     * toolCallId) rather than a single current-tool slot, because pi-agent-core
     * dispatches a turn's tool calls in parallel via Promise.all — a single slot
     * would let the second start overwrite the first.
     */
    status: "running" | "done";
    /**
     * Live progress of subagents spawned by this tool call. Populated only for
     * `subagent` tool calls, from the `partialResult.details.results` payload of
     * `tool_execution_update` events (and refreshed once more from the end
     * event's final results). Recursive: each child's own progress may carry
     * further children via its `recentTools[i].children`.
     */
    children?: AgentResult[];
}

interface AgentProgress {
    agent: string;
    status: "pending" | "running" | "completed" | "failed";
    task: string;
    /**
     * Chronological log of tool calls — running and done interleaved. The
     * renderer prefixes running entries with `▸` and done ones with `  `.
     */
    recentTools: ToolEvent[];
    toolCount: number;
    tokens: number;
    durationMs: number;
    lastMessage: string;
    error?: string;
}

interface AgentResult {
    agent: string;
    task: string;
    output: string;
    exitCode: number;
    progress: AgentProgress;
    model?: string;
    contextWindow?: number;
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        turns: number;
    };
}

interface Details {
    results: AgentResult[];
}

// ── Config ─────────────────────────────────────────────────────────────

interface ExtensionConfig {
    maxConcurrency?: number;
    /** Max stderr bytes retained from a failed child process. */
    maxStderrBytes?: number;
    /** Print config/agent validation warnings to stderr. */
    debug?: boolean;
}

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(EXT_DIR, "agents");
const TOOLS_DIR = path.join(EXT_DIR, "tools");
const CONFIG_PATH = path.join(EXT_DIR, "config.json");
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY_LIMIT = 32;
const DEFAULT_MAX_STDERR_BYTES = 20_000;

function warn(message: string): void {
    // Keep extension loading non-fatal for malformed optional config, but make the
    // fallback visible. stderr is safe for pi's json-mode children; stdout is the
    // machine-readable event stream.
    console.warn(`[subagents] ${message}`);
}

function coercePositiveInteger(
    value: unknown,
    fallback: number,
    field: string,
    max?: number,
): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        warn(
            `Invalid config.${field}=${JSON.stringify(value)}; using ${fallback}.`,
        );
        return fallback;
    }
    if (max !== undefined && value > max) {
        warn(
            `Invalid config.${field}=${value}; maximum is ${max}. Using ${max}.`,
        );
        return max;
    }
    return value;
}

function loadConfig(): Required<
    Pick<ExtensionConfig, "maxConcurrency" | "maxStderrBytes">
> &
    Pick<ExtensionConfig, "debug"> {
    let raw: ExtensionConfig = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            raw = JSON.parse(
                fs.readFileSync(CONFIG_PATH, "utf-8"),
            ) as ExtensionConfig;
        }
    } catch (err) {
        warn(
            `Failed to parse config.json: ${err instanceof Error ? err.message : String(err)}. Using defaults.`,
        );
    }
    return {
        maxConcurrency: coercePositiveInteger(
            raw.maxConcurrency,
            DEFAULT_MAX_CONCURRENCY,
            "maxConcurrency",
            MAX_CONCURRENCY_LIMIT,
        ),
        maxStderrBytes: coercePositiveInteger(
            raw.maxStderrBytes,
            DEFAULT_MAX_STDERR_BYTES,
            "maxStderrBytes",
        ),
        debug: raw.debug === true,
    };
}

// Built-in tools that pi provides natively (no extension needed)
const BUILTIN_TOOLS = new Set([
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
    "ls",
]);

/** Tools provided by external extensions that pi auto-discovers at startup.
 *  We don't pass `--extension` for these, but they must be known to
 *  ALL_KNOWN_TOOLS so wildcard+exclude whitelist computation includes them. */
const EXTERNAL_TOOLS = new Set([
    "web_search",
    "web_fetch",
]);

// Tools implemented by this extension itself. Other extension-provided tools
// are resolved by pi's normal extension discovery.
const LOCAL_TOOL_EXTENSIONS: Record<string, string> = {
    safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
    subagent: path.join(EXT_DIR, "index.ts"),
};

/** Union of every tool name this extension can discover — built-in pi tools
 *  plus the local extension tools above. Used when computing the effective
 *  whitelist for wildcard/blacklist mode (`tools: "*"` + `tools_exclude`). */
const ALL_KNOWN_TOOLS: Set<string> = new Set([
    ...BUILTIN_TOOLS,
    ...Object.keys(LOCAL_TOOL_EXTENSIONS),
    ...EXTERNAL_TOOLS,
]);

function parseListField(value: unknown): string[] {
    if (Array.isArray(value))
        return value
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean);
    if (typeof value === "string")
        return value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    if (value === undefined || value === null) return [];
    return [String(value).trim()].filter(Boolean);
}

// ── Agent Discovery & Registration ────────────────────────────────────

let agents: AgentConfig[] = [];

// Read once at module load. If we're a child subagent process whose parent
// pinned an allowlist, we silently ignore any agent (built-in OR registered
// later by a third-party extension) that isn't in the list.
const SUBAGENT_ALLOWLIST: string[] | undefined = (() => {
    const raw = process.env.PI_SUBAGENT_ALLOWED;
    if (!raw) return undefined;
    const list = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return list.length > 0 ? list : undefined;
})();

export function registerAgent(config: AgentConfig): void {
    if (SUBAGENT_ALLOWLIST && !SUBAGENT_ALLOWLIST.includes(config.name)) return;
    agents.push(config);
}

export function unregisterAgent(name: string): void {
    agents = agents.filter((a) => a.name !== name);
}

// Expose registration functions globally so other extensions loaded via jiti
// (which creates separate module instances) can access the shared agents array.
(globalThis as any).__subagents = { registerAgent, unregisterAgent };

function loadAgents(): AgentConfig[] {
    const agents: AgentConfig[] = [];
    if (!fs.existsSync(AGENTS_DIR)) return agents;
    for (const entry of fs.readdirSync(AGENTS_DIR)) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(AGENTS_DIR, entry);
        const content = fs.readFileSync(filePath, "utf-8");
        const { frontmatter, body } =
            parseFrontmatter<Record<string, unknown>>(content);
        if (!frontmatter.name) continue;
        const tools = parseListField(frontmatter.tools);
        const toolsExclude = parseListField(frontmatter.tools_exclude);
        const subagentAgents = parseListField(frontmatter.subagent_agents);
        const config: AgentConfig = {
            name: String(frontmatter.name),
            description:
                typeof frontmatter.description === "string"
                    ? frontmatter.description
                    : "",
            tools,
            tools_exclude: toolsExclude.length > 0 ? toolsExclude : undefined,
            model:
                typeof frontmatter.model === "string"
                    ? frontmatter.model
                    : "anthropic/claude-sonnet-4-6",
            thinking:
                typeof frontmatter.thinking === "string"
                    ? frontmatter.thinking
                    : "medium",
            systemPrompt: body,
            filePath,
            subagentAgents:
                subagentAgents.length > 0 ? subagentAgents : undefined,
        };
        agents.push(config);
    }
    return agents;
}

// ── Pi Binary Resolution ──────────────────────────────────────────────

function resolvePiBinary(): { command: string; baseArgs: string[] } {
    // Resolve the pi entry point from process.argv[1]
    const entry = process.argv[1];
    if (entry) {
        try {
            const realEntry = fs.realpathSync(entry);
            if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
                return { command: process.execPath, baseArgs: [realEntry] };
            }
        } catch {}
    }
    return { command: "pi", baseArgs: [] };
}

// ── Formatting Utilities ──────────────────────────────────────────────

function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
    return `${Math.round(n / 1000)}k`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatContextUsage(
    tokens: number,
    contextWindow: number | undefined,
): string {
    if (!contextWindow) return `${formatTokens(tokens)} ctx`;
    const pct = (tokens / contextWindow) * 100;
    const maxStr =
        contextWindow >= 1_000_000
            ? `${(contextWindow / 1_000_000).toFixed(1)}M`
            : `${Math.round(contextWindow / 1000)}k`;
    return `${pct.toFixed(1)}%/${maxStr}`;
}

function formatToolPreview(
    name: string,
    args: Record<string, unknown>,
): string {
    switch (name) {
        case "bash":
        case "safe_bash":
            return `$ ${((args.command as string) || "").slice(0, 80)}`;
        case "read":
            return `read ${(args.path as string) || ""}`;
        case "write":
            return `write ${(args.path as string) || ""}`;
        case "edit":
            return `edit ${(args.path as string) || ""}`;
        case "grep":
            return `grep ${(args.pattern as string) || ""}`;
        case "find":
            return `find ${(args.pattern as string) || ""}`;
        case "ls":
            return `ls ${(args.path as string) || "."}`;
        case "web_search":
            return `search "${(args.query as string) || ""}"`;
        case "web_fetch":
            return `fetch ${(args.url as string) || ""}`;
        default: {
            const s = JSON.stringify(args);
            return `${name} ${s.slice(0, 60)}`;
        }
    }
}

function truncLine(text: string, maxWidth: number): string {
    // Collapse embedded newlines first so we render exactly one visible line.
    // We can't strip them inside `text` directly (would also touch ANSI escapes
    // like "\x1b[0m"), so we only target literal \r and \n outside of escapes.
    if (text.includes("\n") || text.includes("\r")) {
        text = text.replace(/\r?\n/g, "↵ ");
    }
    if (visibleWidth(text) <= maxWidth) return text;
    let result = "";
    let width = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        // Skip ANSI escape sequences
        if (ch === "\x1b") {
            const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
            if (match) {
                result += match[0];
                i += match[0].length - 1;
                continue;
            }
        }
        if (width >= maxWidth - 1) {
            return result + "…";
        }
        result += ch;
        width++;
    }
    return result;
}

// ── Subagent Execution ────────────────────────────────────────────────

async function buildPiArgs(
    agent: AgentConfig,
    task: string,
    cwd: string,
): Promise<{
    args: string[];
    tempDir: string;
    childEnv: NodeJS.ProcessEnv | undefined;
}> {
    const piBin = resolvePiBinary();
    const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-sub-"),
    );

    // Write system prompt to temp file
    const promptPath = path.join(tempDir, `${agent.name}.md`);
    await withFileMutationQueue(promptPath, async () => {
        await fs.promises.writeFile(promptPath, agent.systemPrompt, {
            encoding: "utf-8",
            mode: 0o600,
        });
    });

    const args = [
        ...piBin.baseArgs,
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-skills",
    ];

    // Separate builtin tools from custom tools. Both kinds share the same
    // --tools allowlist in pi; --no-tools would disable extension tools too.
    const allowlist: string[] = [];
    const extensionPaths = new Set<string>();

    const isWildcard =
        agent.tools.length === 1 && agent.tools[0] === "*";

    if (isWildcard) {
        // Wildcard mode: grant everything, optionally subtract blacklisted tools.
        const excludeSet = new Set(agent.tools_exclude ?? []);
        if (excludeSet.size > 0) {
            // Compute effective whitelist = all known tools minus excluded.
            // NOTE: only tools listed in ALL_KNOWN_TOOLS are included in the
            // computed whitelist. Extension tools not in that set won't be
            // available unless the extension is loaded separately.
            for (const tool of ALL_KNOWN_TOOLS) {
                if (!excludeSet.has(tool)) allowlist.push(tool);
            }
            args.push("--tools", allowlist.join(","));
            // Load non-excluded local extensions.
            for (const [tool, extPath] of Object.entries(
                LOCAL_TOOL_EXTENSIONS,
            )) {
                if (!excludeSet.has(tool)) extensionPaths.add(extPath);
            }
        } else {
            // Pure wildcard — don't pass --tools at all; pi defaults to every
            // built-in and extension tool that is loaded.
            for (const extPath of Object.values(LOCAL_TOOL_EXTENSIONS)) {
                extensionPaths.add(extPath);
            }
        }
    } else {
        // Conventional whitelist (existing behaviour).
        for (const tool of agent.tools) {
            if (BUILTIN_TOOLS.has(tool)) {
                allowlist.push(tool);
                continue;
            }
            allowlist.push(tool);
            const extPath = LOCAL_TOOL_EXTENSIONS[tool];
            if (extPath) extensionPaths.add(extPath);
        }

        if (allowlist.length > 0) {
            // --tools is a unified allowlist that applies to built-in, extension, and custom tools.
            args.push("--tools", allowlist.join(","));
        } else {
            // Agent declared no tools — disable everything.
            args.push("--no-tools");
        }
    }

    for (const extPath of extensionPaths) {
        args.push("--extension", extPath);
    }

    args.push("--models", agent.model);
    args.push("--thinking", agent.thinking);
    args.push("--append-system-prompt", promptPath);

    // Handle long tasks by writing to file
    const TASK_LIMIT = 8000;
    if (task.length > TASK_LIMIT) {
        const taskPath = path.join(tempDir, "task.md");
        await withFileMutationQueue(taskPath, async () => {
            await fs.promises.writeFile(taskPath, `Task: ${task}`, {
                encoding: "utf-8",
                mode: 0o600,
            });
        });
        args.push(`@${taskPath}`);
    } else {
        args.push(`Task: ${task}`);
    }

    // If this agent is allowed to spawn subagents AND we want to restrict which
    // ones, pass the allowlist down via env. The child pi process loads this
    // extension and filters its agent registry before exposing tool descriptions
    // to the LLM — so the child literally cannot request an agent outside the
    // allowlist (the name isn't in its prompt).
    let childEnv: NodeJS.ProcessEnv | undefined;
    if (
        agent.tools.includes("subagent") &&
        agent.subagentAgents &&
        agent.subagentAgents.length > 0
    ) {
        childEnv = {
            ...process.env,
            PI_SUBAGENT_ALLOWED: agent.subagentAgents.join(","),
        };
    }

    return { args: [piBin.command, ...args], tempDir, childEnv };
}

function extractTextFromContent(content: unknown): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
    }
    return "";
}

/** Collapse any whitespace run (incl. newlines) into a single space. Used to
 *  keep tool-arg previews to one renderable line in collapsed view. */
function flatten(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

// Per-event hard cap on stored arg previews. Even in expanded view we don't
// want a 50KB bash heredoc sitting in memory per tool call across last-20
// `recentTools` slots per agent across N agents. A few KB covers any realistic
// command; anything longer is almost certainly a generated payload the user
// doesn't need to read inline anyway.
const MAX_ARG_PREVIEW = 4000;

function appendLimited(
    buffer: string,
    chunk: string,
    maxBytes: number,
): string {
    const next = buffer + chunk;
    if (Buffer.byteLength(next, "utf-8") <= maxBytes) return next;
    const marker = "\n[stderr truncated; showing tail]\n";
    const markerBytes = Buffer.byteLength(marker, "utf-8");
    if (maxBytes <= markerBytes)
        return Buffer.from(marker, "utf-8")
            .subarray(0, maxBytes)
            .toString("utf-8");
    const keep = maxBytes - markerBytes;
    return (
        marker + Buffer.from(next, "utf-8").subarray(-keep).toString("utf-8")
    );
}

function extractToolArgsPreview(args: Record<string, unknown>): string {
    const cap = (s: string) =>
        s.length > MAX_ARG_PREVIEW ? s.slice(0, MAX_ARG_PREVIEW) + "…" : s;
    if (args.command) return cap(flatten(String(args.command)));
    if (args.path) return cap(flatten(String(args.path)));
    if (args.query) return `"${cap(flatten(String(args.query)))}"`;
    if (args.url) return cap(flatten(String(args.url)));
    if (args.pattern) return cap(flatten(String(args.pattern)));
    // `subagent` tool args: show which agent(s) it's calling, not the full task body.
    if (args.agent) return flatten(String(args.agent));
    if (Array.isArray(args.tasks)) {
        const names = (args.tasks as Array<{ agent?: string }>)
            .map((t) => t?.agent || "?")
            .join(", ");
        return `parallel(${names})`;
    }
    return cap(flatten(JSON.stringify(args)));
}

async function runSubagent(
    agent: AgentConfig,
    task: string,
    cwd: string,
    signal: AbortSignal | undefined,
    maxStderrBytes: number,
    onUpdate?: (progress: AgentProgress, usage: AgentResult["usage"]) => void,
): Promise<AgentResult> {
    const { args, tempDir, childEnv } = await buildPiArgs(agent, task, cwd);
    const command = args[0];
    const spawnArgs = args.slice(1);

    const result: AgentResult = {
        agent: agent.name,
        task,
        output: "",
        exitCode: 0,
        model: agent.model,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
        },
        progress: {
            agent: agent.name,
            status: "running",
            task,
            recentTools: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
            lastMessage: "",
        },
    };

    const startTime = Date.now();
    const progress = result.progress;

    const fireUpdate = throttle(() => {
        progress.durationMs = Date.now() - startTime;
        onUpdate?.(progress, result.usage);
    }, 150);

    const exitCode = await new Promise<number>((resolve) => {
        const proc = spawn(command, spawnArgs, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            ...(childEnv ? { env: childEnv } : {}),
        });

        let buf = "";
        let stderrBuf = "";

        const processLine = (line: string) => {
            if (!line.trim()) return;
            try {
                const evt = JSON.parse(line) as any;
                progress.durationMs = Date.now() - startTime;

                if (evt.type === "tool_execution_start") {
                    progress.toolCount++;
                    progress.recentTools.push({
                        tool: evt.toolName,
                        args: extractToolArgsPreview(
                            (evt.args || {}) as Record<string, unknown>,
                        ),
                        toolCallId: evt.toolCallId,
                        status: "running",
                    });
                    fireUpdate();
                }

                // Subagents emit `tool_execution_update` while their own subagent tool
                // runs — the partial result carries the live nested AgentResult[]. We
                // surface that as `children` on the in-flight ToolEvent so the renderer
                // can inline grandchild activity beneath the parent's tool row.
                if (evt.type === "tool_execution_update") {
                    const partial = evt.partialResult as
                        | { details?: { results?: unknown } }
                        | undefined;
                    const nested = partial?.details?.results;
                    if (
                        evt.toolName === "subagent" &&
                        Array.isArray(nested) &&
                        evt.toolCallId
                    ) {
                        const hit = progress.recentTools.find(
                            (t) => t.toolCallId === evt.toolCallId,
                        );
                        if (hit) {
                            hit.children = nested as AgentResult[];
                            fireUpdate();
                        }
                    }
                }

                if (evt.type === "tool_execution_end") {
                    const hit = evt.toolCallId
                        ? progress.recentTools.find(
                              (t) => t.toolCallId === evt.toolCallId,
                          )
                        : undefined;
                    if (hit) {
                        hit.status = "done";
                        // Prefer the end event's final results over the last throttled
                        // update — throttling can drop the trailing update, leaving stale
                        // children visible on a tool that has actually completed.
                        const finalResult = evt.result as
                            | { details?: { results?: unknown } }
                            | undefined;
                        const finalChildren = finalResult?.details?.results;
                        if (
                            evt.toolName === "subagent" &&
                            Array.isArray(finalChildren)
                        ) {
                            hit.children = finalChildren as AgentResult[];
                        }
                    }
                    fireUpdate();
                }

                if (evt.type === "tool_result_end") {
                    fireUpdate();
                }

                if (evt.type === "message_end" && evt.message) {
                    if (evt.message.role === "assistant") {
                        result.usage.turns++;
                        const u = evt.message.usage;
                        if (u) {
                            result.usage.input += u.input || 0;
                            result.usage.output += u.output || 0;
                            result.usage.cacheRead += u.cacheRead || 0;
                            result.usage.cacheWrite += u.cacheWrite || 0;
                            result.usage.cost += u.cost?.total || 0;
                            // Context-window gauge: snapshot of the LATEST assistant turn's usage,
                            // NOT a cumulative sum across turns. Each turn re-sends the whole
                            // conversation as input + cacheRead, so one assistant message already
                            // represents the current context size. Summing across N turns would
                            // inflate the displayed % by roughly Nx (the bug this replaced).
                            // Matches pi's `calculateContextTokens` in core/compaction/compaction.js:
                            // prefer the provider-reported totalTokens, fall back to the 4-component sum.
                            progress.tokens =
                                (u as { totalTokens?: number }).totalTokens ||
                                (u.input || 0) +
                                    (u.output || 0) +
                                    (u.cacheRead || 0) +
                                    (u.cacheWrite || 0);
                        }
                        if (evt.message.model) result.model = evt.message.model;
                        if (evt.message.errorMessage)
                            progress.error = evt.message.errorMessage;

                        const text = extractTextFromContent(
                            evt.message.content,
                        );
                        if (text) {
                            result.output = text;
                            // Extract just the prose "thinking" text — skip code blocks
                            const proseLines: string[] = [];
                            let inCodeBlock = false;
                            for (const line of text.split("\n")) {
                                if (line.trimStart().startsWith("```")) {
                                    inCodeBlock = !inCodeBlock;
                                    continue;
                                }
                                if (!inCodeBlock && line.trim()) {
                                    proseLines.push(line.trim());
                                }
                            }
                            if (proseLines.length > 0) {
                                progress.lastMessage = proseLines
                                    .slice(0, 3)
                                    .join(" ");
                            }
                        }
                    }

                    fireUpdate();
                }
            } catch {
                // Non-JSON lines are expected
            }
        };

        proc.stdout.on("data", (d: Buffer) => {
            buf += d.toString();
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            lines.forEach(processLine);
        });

        proc.stderr.on("data", (d: Buffer) => {
            stderrBuf = appendLimited(stderrBuf, d.toString(), maxStderrBytes);
        });

        proc.on("close", (code) => {
            if (buf.trim()) processLine(buf);
            if (code !== 0 && stderrBuf.trim() && !progress.error) {
                progress.error = stderrBuf.trim();
            }
            resolve(code ?? 1);
        });

        proc.on("error", (err) => {
            progress.error = `Failed to start subagent process: ${err.message}`;
            resolve(1);
        });

        if (signal) {
            const kill = () => {
                proc.kill("SIGTERM");
                setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
            };
            if (signal.aborted) kill();
            else signal.addEventListener("abort", kill, { once: true });
        }
    });

    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    result.exitCode = exitCode;
    progress.status =
        exitCode === 0 && !progress.error ? "completed" : "failed";
    progress.durationMs = Date.now() - startTime;
    if (progress.error)
        result.output = result.output || `Error: ${progress.error}`;

    if (result.output.length > DEFAULT_MAX_BYTES) {
        const trunc = truncateHead(result.output, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
        });
        result.output = trunc.content;
        if (trunc.truncated) {
            result.output += "\n\n[Output truncated]";
        }
    }

    return result;
}

// ── Throttle ──────────────────────────────────────────────────────────

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
    let lastCall = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return ((...args: any[]) => {
        const now = Date.now();
        const remaining = ms - (now - lastCall);
        if (remaining <= 0) {
            lastCall = now;
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            fn(...args);
        } else if (!timer) {
            timer = setTimeout(() => {
                lastCall = Date.now();
                timer = undefined;
                fn(...args);
            }, remaining);
        }
    }) as T;
}

// ── Parallel Execution with Concurrency Limit ─────────────────────────

/**
 * Process-wide cap on simultaneous `runSubagent` calls. Each `execute()` of the
 * `subagent` tool is independent (pi runs LLM tool calls via `Promise.all`), so
 * we serialize at the `runSubagent` boundary. Per-process scope only — nested
 * subagent processes have their own semaphore, so the cap applies to direct
 * children, not the whole tree (which keeps things deadlock-free).
 */
class Semaphore {
    private inFlight = 0;
    private readonly waiters: Array<() => void> = [];
    constructor(private readonly max: number) {}

    private async acquire(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted)
            throw new Error(
                "Subagent cancelled before acquiring concurrency slot",
            );
        if (this.inFlight < this.max) {
            this.inFlight++;
            return;
        }
        await new Promise<void>((resolve, reject) => {
            let waiter: (() => void) | undefined;
            let onAbort: (() => void) | undefined;
            const cleanup = () => {
                if (waiter) {
                    const idx = this.waiters.indexOf(waiter);
                    if (idx >= 0) this.waiters.splice(idx, 1);
                }
                if (onAbort) signal?.removeEventListener("abort", onAbort);
            };
            onAbort = () => {
                cleanup();
                reject(
                    new Error(
                        "Subagent cancelled while waiting for concurrency slot",
                    ),
                );
            };
            waiter = () => {
                cleanup();
                this.inFlight++;
                resolve();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            this.waiters.push(waiter);
        });
    }

    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.acquire(signal);
        try {
            return await fn();
        } finally {
            this.inFlight--;
            const next = this.waiters.shift();
            if (next) next();
        }
    }
}

// ── Rendering ─────────────────────────────────────────────────────────

type Theme = ExtensionContext["ui"]["theme"];
type Component =
    ReturnType<typeof Text.prototype.render> extends string[] ? Text : any;

function getTermWidth(): number {
    return process.stdout.columns || 120;
}

function renderAgentProgress(
    r: AgentResult,
    theme: Theme,
    expanded: boolean,
    w: number,
    depth: number = 0,
): Container {
    const c = new Container();
    const prog = r.progress;
    const isRunning = prog.status === "running";
    const isPending = prog.status === "pending";
    const nested = depth > 0;

    // Indent prefix for nested levels. ANSI escapes are zero-width so this works
    // with colored content. Children are visually offset by 2 spaces per depth.
    const indent = nested ? "  ".repeat(depth) : "";
    // Available width shrinks with indent so truncLine still fits one line.
    const innerW = Math.max(20, w - indent.length);

    // `line(content)`: emit one indented, optionally-truncated row.
    // In expanded mode we still indent but don't truncate — the Text component
    // wraps and we want every wrapped line to share the same left margin, so we
    // keep the indent as a hard prefix on the first line only (pi-tui Text
    // doesn't expose a per-line gutter). Wrapping at depth is rare anyway since
    // the lines that wrap (lastMessage, full output) only render at depth 0.
    const addLine = (content: string) => {
        if (expanded) {
            c.addChild(new Text(indent + content, 0, 0));
        } else {
            c.addChild(new Text(indent + truncLine(content, innerW), 0, 0));
        }
    };

    // Header: icon + agent + stats (always one line)
    const icon = isRunning
        ? theme.fg("warning", "⟳")
        : isPending
          ? theme.fg("dim", "○")
          : r.exitCode === 0
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");
    const stats = `${prog.toolCount} tools · ${formatDuration(prog.durationMs)}`;
    const modelStr = r.model ? theme.fg("dim", ` (${r.model})`) : "";
    addLine(
        `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelStr} — ${theme.fg("dim", stats)}`,
    );

    // NOTE: the task body used to be rendered here at depth 0 (truncated when
    // collapsed, full when expanded). It's now owned by `renderCall` above this
    // block in the same tool shell — the call header shows the truncated
    // preview when collapsed and the full streaming prompt when expanded — so
    // repeating it here would duplicate the prompt on screen. Nested children
    // never rendered Task in the first place; the parent's recentTools row
    // above each child already conveys the dispatch.

    // Helper for rendering one tool row + recursively rendering its children.
    const renderToolRow = (
        toolName: string,
        args: string,
        children: AgentResult[] | undefined,
        isCurrent: boolean,
    ) => {
        const body = args ? `${toolName}: ${args}` : toolName;
        if (isCurrent) {
            addLine(theme.fg("warning", `▸ ${body}`));
        } else {
            addLine(theme.fg("muted", `  ${body}`));
        }
        if (children && children.length > 0) {
            for (const child of children) {
                c.addChild(
                    renderAgentProgress(child, theme, expanded, w, depth + 1),
                );
            }
        }
    };

    // Tool log — running and done interleaved in chronological order. Running
    // entries get the `▸` marker; done ones get a muted `  ` prefix. Children
    // (live subagent activity) render inline beneath each row.
    for (const t of prog.recentTools) {
        renderToolRow(t.tool, t.args, t.children, t.status === "running");
    }

    // Latest assistant message (prose "thinking"). Rendered at every depth so a
    // nested subagent's current thought sits at the bottom of its own indented
    // block, mirroring how the master box shows it under all tool rows. At depth
    // 0 we precede it with a blank line for visual separation from the tool log;
    // at depth>=1 we skip the spacer so the row stays grouped with the child's
    // tool list above and doesn't break the visual run between sibling children.
    if (prog.lastMessage) {
        if (!nested) c.addChild(new Spacer(1));
        addLine(theme.fg("text", prog.lastMessage));
    }

    // Expanded final output — only at depth 0. Nested levels are summarized via
    // their own tool list; the master-level result block is enough context.
    if (!nested && !isRunning && r.output && expanded) {
        c.addChild(new Spacer(1));
        const mdTheme = getMarkdownTheme();
        c.addChild(new Markdown(r.output, 0, 0, mdTheme));
    }

    // Usage line. Includes the context %/max gauge at every depth — each
    // subagent carries its own model/contextWindow and its own token count, so
    // the gauge is meaningful per-row even for nested children.
    if (!nested) c.addChild(new Spacer(1));
    const usageParts: string[] = [];
    if (r.usage.input)
        usageParts.push(theme.fg("dim", `↑${formatTokens(r.usage.input)}`));
    if (r.usage.output)
        usageParts.push(theme.fg("dim", `↓${formatTokens(r.usage.output)}`));
    if (r.usage.cacheRead)
        usageParts.push(theme.fg("dim", `R${formatTokens(r.usage.cacheRead)}`));
    if (r.usage.cacheWrite)
        usageParts.push(
            theme.fg("dim", `W${formatTokens(r.usage.cacheWrite)}`),
        );
    if (r.usage.cost)
        usageParts.push(theme.fg("dim", `$${r.usage.cost.toFixed(3)}`));
    if (prog.tokens > 0) {
        const ctxStr = formatContextUsage(prog.tokens, r.contextWindow);
        const pct = r.contextWindow ? (prog.tokens / r.contextWindow) * 100 : 0;
        let coloredCtx: string;
        if (pct > 90) {
            coloredCtx = theme.fg("error", ctxStr);
        } else if (pct > 70) {
            coloredCtx = theme.fg("warning", ctxStr);
        } else {
            coloredCtx = theme.fg("dim", ctxStr);
        }
        usageParts.push(coloredCtx);
    }
    if (usageParts.length) {
        addLine(usageParts.join(" "));
    }

    // Error
    if (prog.error) {
        addLine(theme.fg("error", `Error: ${prog.error}`));
    }

    return c;
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    const config = loadConfig();
    const semaphore = new Semaphore(
        config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    );
    agents = loadAgents();
    if (config.debug) {
        warn(
            `Loaded ${agents.length} agent(s): ${agents.map((a) => a.name).join(", ") || "none"}`,
        );
    }

    // If spawned as a child by a parent subagent process, PI_SUBAGENT_ALLOWED
    // pins which agents we're allowed to expose. Filter the registry now, before
    // any tool description sees the agent list — the child LLM should not even
    // know that other agents exist.
    if (SUBAGENT_ALLOWLIST) {
        agents = agents.filter((a) => SUBAGENT_ALLOWLIST.includes(a.name));
    }

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description:
            "Run an isolated subagent for delegated reasoning or implementation work. Subagents have no conversation context; provide a complete task brief.",
        promptSnippet: "Run subagents for delegated tasks",
        promptGuidelines: [
            "Use subagents for delegated reasoning work, not for one-off simple tool calls. If a single read/search/fetch is enough, call that tool directly.",
            "Use scout for read-only codebase reconnaissance: locating files, mapping architecture, tracing references, or summarizing unfamiliar areas.",
            "Use researcher for external web research that needs multiple searches/pages synthesized into a sourced brief.",
            "Use worker only for isolated implementation tasks where file edits are intended or explicitly acceptable. Worker can modify files.",
            "Subagents have NO context from the current conversation. The task must be self-contained: include goals, relevant paths, constraints, expected output, and whether edits are allowed.",
            "For independent investigations, emit multiple subagent tool calls in the same turn so they can run in parallel. Do not serialize independent subagent calls.",
            "Prefer scout/researcher before worker when you only need information. Use worker when you need a focused change plus verification.",
        ],
        parameters: Type.Object({
            agent: Type.String({ description: "Name of the agent to invoke" }),
            task: Type.String({ description: "Task description" }),
            cwd: Type.Optional(
                Type.String({
                    description: "Working directory for the agent process",
                }),
            ),
        }),

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const cwd = ctx.cwd;

            if (!params.agent || !params.task) {
                throw new Error(
                    "`subagent` requires both `agent` and `task`. To fan out work, emit multiple `subagent` tool calls in the same turn — they run in parallel.",
                );
            }

            const agent = agents.find((a) => a.name === params.agent);
            if (!agent) {
                const available =
                    agents.map((a) => a.name).join(", ") || "none";
                throw new Error(
                    `Unknown agent: ${params.agent}. Available agents: ${available}`,
                );
            }

            const [provider, modelId] = (agent.model || "").split("/");
            const contextWindow =
                provider && modelId
                    ? ctx.modelRegistry.find(provider, modelId)?.contextWindow
                    : undefined;
            const liveResult: AgentResult = {
                agent: params.agent,
                task: params.task,
                output: "",
                exitCode: -1,
                model: agent.model,
                contextWindow,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: 0,
                    turns: 0,
                },
                progress: {
                    agent: params.agent,
                    status: "running" as const,
                    task: params.task,
                    recentTools: [],
                    toolCount: 0,
                    tokens: 0,
                    durationMs: 0,
                    lastMessage: "",
                },
            };

            const result = await semaphore.run(
                () =>
                    runSubagent(
                        agent,
                        params.task!,
                        params.cwd ?? cwd,
                        signal,
                        config.maxStderrBytes,
                        (progress, usage) => {
                            liveResult.progress = progress;
                            liveResult.usage = { ...usage };
                            onUpdate?.({
                                content: [
                                    { type: "text", text: "(running...)" },
                                ],
                                details: { results: [liveResult] },
                            });
                        },
                    ),
                signal,
            );

            result.contextWindow = contextWindow;
            const isError = result.exitCode !== 0 || !!result.progress.error;
            return {
                content: [
                    { type: "text", text: result.output || "(no output)" },
                ],
                details: { results: [result] },
                ...(isError ? { isError: true } : {}),
            };
        },

        // ── Render: tool call header ──
        //
        // Two views, toggled by ctrl+o (pi flips `context.expanded` and re-invokes
        // this on every flip). pi-agent-core also re-invokes this on every streamed
        // args delta, so in the expanded branch the full task text grows token by
        // token while the master LLM is still writing the prompt — mirroring how
        // `write`/`edit` reveal their `content` field live.
        renderCall(args, theme, context) {
            // Collapsed view (default): single-line header + 60-char task preview.
            if (!context.expanded) {
                if (!args.agent) {
                    return new Text(
                        theme.fg("toolTitle", theme.bold("subagent")),
                        0,
                        0,
                    );
                }
                let taskPreview = "";
                if (args.task) {
                    const truncated =
                        args.task.length > 60
                            ? args.task.slice(0, 60) + "…"
                            : args.task;
                    taskPreview = truncated.replace(/\n/g, " ");
                }
                return new Text(
                    `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}`,
                    0,
                    0,
                );
            }

            // Expanded view: header + full streaming task body. Reuse the previous
            // Container so we don't allocate on every streamed token (same pattern
            // the built-in write/edit tools use via context.lastComponent).
            let c: Container;
            if (context.lastComponent instanceof Container) {
                context.lastComponent.clear();
                c = context.lastComponent;
            } else {
                c = new Container();
            }
            const agentLabel = args.agent
                ? ` ${theme.fg("accent", args.agent)}`
                : "";
            const cwdLabel = args.cwd
                ? theme.fg("dim", ` (cwd: ${args.cwd})`)
                : "";
            c.addChild(
                new Text(
                    `${theme.fg("toolTitle", theme.bold("subagent"))}${agentLabel}${cwdLabel}`,
                    0,
                    0,
                ),
            );
            if (args.task) {
                c.addChild(new Spacer(1));
                // Plain Text wraps to terminal width. Markdown would also work but
                // the task prompt is the master's raw instruction text, not authored
                // markdown, and parsing partial markdown mid-stream looks jittery.
                c.addChild(new Text(theme.fg("text", args.task), 0, 0));
            }
            return c;
        },

        // ── Render: result ──
        renderResult(result, options, theme, context) {
            const details = result.details as Details | undefined;
            if (!details?.results?.length) {
                const t = result.content[0];
                const text = t?.type === "text" ? t.text : "(no output)";
                return new Text(text.slice(0, 200), 0, 0);
            }

            const w = getTermWidth() - 4;
            const expanded = options.expanded;
            const c = new Container();
            c.addChild(
                renderAgentProgress(details.results[0], theme, expanded, w),
            );
            return c;
        },
    });
}

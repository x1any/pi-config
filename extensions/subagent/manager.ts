import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
    type AgentSession,
    createAgentSession,
    DefaultResourceLoader,
    defineTool,
    type ExtensionAPI,
    type ExtensionContext,
    getAgentDir,
    SessionManager,
    SettingsManager,
    truncateHead,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { createExaSdkTools, type ExaSdkToolBundle } from "../exa/index.ts";
import { MODE_POLICIES, type SubagentMode } from "./modes.ts";
import {
    type PatchResult,
    WorktreeBlockedError,
    type WorktreeLease,
    WorktreeManager,
} from "./worktree.ts";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(EXT_DIR, "config.json");
const RECENT_TOOL_LIMIT = 5;
const UPDATE_THROTTLE_MS = 150;

const DEFAULT_CONFIG: SubagentConfig = {
    maxConcurrency: 3,
    executionTimeoutMs: 600_000,
    maxOutputBytes: 100_000,
};

const ReportSchema = Type.Object({
    status: StringEnum(["completed", "partial", "blocked", "failed"] as const),
    summary: Type.String({ minLength: 1, maxLength: 20_000 }),
    evidence: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 50 }),
    ),
    verification: Type.Optional(
        Type.Array(
            Type.Object({
                command: Type.String({ minLength: 1, maxLength: 4_000 }),
                exitCode: Type.Integer(),
                summary: Type.String({ minLength: 1, maxLength: 4_000 }),
            }),
            { maxItems: 30 },
        ),
    ),
    unresolved: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 30 }),
    ),
});

export type StructuredReport = Static<typeof ReportSchema>;

export interface SubagentConfig {
    maxConcurrency: number;
    executionTimeoutMs: number;
    maxOutputBytes: number;
}

export type SubagentStatus =
    | "queued"
    | "preparing"
    | "running"
    | "finalizing"
    | "completed"
    | "partial"
    | "blocked"
    | "failed"
    | "cancelled";

export interface ToolActivity {
    id: string;
    name: string;
    preview: string;
    status: "running" | "completed" | "failed";
}

export interface UsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
}

export interface VerificationResult {
    command: string;
    exitCode: number;
    summary: string;
}

export interface PatchDetails {
    path?: string;
    preview: string;
    bytes: number;
    appliesCleanly: boolean;
    applyError?: string;
}

export interface SubagentDetails {
    mode: SubagentMode;
    task: string;
    status: SubagentStatus;
    summary: string;
    evidence?: string[];
    verification?: VerificationResult[];
    unresolved?: string[];
    changedFiles?: string[];
    patch?: PatchDetails;
    error?: string;
    model?: string;
    durationMs: number;
    toolCount: number;
    currentTools: ToolActivity[];
    recentTools: ToolActivity[];
    usage: UsageStats;
}

export interface RunRequest {
    mode: SubagentMode;
    task: string;
    cwd?: string;
}

interface RunHandle {
    id: string;
    request: RunRequest;
    status: SubagentStatus;
    startedAt: number;
    controller: AbortController;
    session?: AgentSession;
    workspace?: WorktreeLease;
    timeout?: ReturnType<typeof setTimeout>;
    cancelReason?: "parent" | "timeout" | "shutdown";
    report?: StructuredReport;
    lastAssistantText: string;
    agentError?: string;
    progress: RunProgress;
}

type UpdateCallback = (details: SubagentDetails) => void;

function warn(message: string): void {
    console.warn(`[subagent] ${message}`);
}

function boundedInteger(
    value: unknown,
    fallback: number,
    field: string,
    min: number,
    max: number,
): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        warn(`Invalid config.${field}=${JSON.stringify(value)}; using ${fallback}.`);
        return fallback;
    }
    return value;
}

export function loadSubagentConfig(): SubagentConfig {
    let raw: Partial<SubagentConfig> = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<SubagentConfig>;
        }
    } catch (error) {
        warn(
            `Failed to read config.json: ${error instanceof Error ? error.message : String(error)}; using defaults.`,
        );
    }

    return {
        maxConcurrency: boundedInteger(
            raw.maxConcurrency,
            DEFAULT_CONFIG.maxConcurrency,
            "maxConcurrency",
            1,
            8,
        ),
        executionTimeoutMs: boundedInteger(
            raw.executionTimeoutMs,
            DEFAULT_CONFIG.executionTimeoutMs,
            "executionTimeoutMs",
            1_000,
            3_600_000,
        ),
        maxOutputBytes: boundedInteger(
            raw.maxOutputBytes,
            DEFAULT_CONFIG.maxOutputBytes,
            "maxOutputBytes",
            1_024,
            1_000_000,
        ),
    };
}

function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part): part is { type: "text"; text: string } => {
            if (!part || typeof part !== "object") return false;
            const item = part as { type?: unknown; text?: unknown };
            return item.type === "text" && typeof item.text === "string";
        })
        .map((part) => part.text)
        .join("\n");
}

function flatten(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function previewTool(name: string, args: Record<string, unknown>): string {
    let value = "";
    if (name === "bash" && typeof args.command === "string") value = `$ ${args.command}`;
    else if (typeof args.path === "string") value = args.path;
    else if (typeof args.pattern === "string") value = args.pattern;
    else if (typeof args.query === "string") value = args.query;
    else if (Array.isArray(args.urls)) value = args.urls.join(", ");
    else value = JSON.stringify(args);

    const compact = flatten(value);
    return compact.length > 300 ? `${compact.slice(0, 299)}…` : compact;
}

function emptyUsage(): UsageStats {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
    };
}

class RunProgress {
    readonly current = new Map<string, ToolActivity>();
    readonly recent: ToolActivity[] = [];
    readonly usage = emptyUsage();
    toolCount = 0;

    start(id: string, name: string, args: Record<string, unknown>): void {
        this.toolCount++;
        this.current.set(id, {
            id,
            name,
            preview: previewTool(name, args),
            status: "running",
        });
    }

    finish(id: string, name: string, isError: boolean): void {
        const activity = this.current.get(id) ?? {
            id,
            name,
            preview: "",
            status: "running" as const,
        };
        this.current.delete(id);
        this.recent.push({
            ...activity,
            status: isError ? "failed" : "completed",
        });
        if (this.recent.length > RECENT_TOOL_LIMIT) {
            this.recent.splice(0, this.recent.length - RECENT_TOOL_LIMIT);
        }
    }

    recordAssistant(message: any): string {
        this.usage.turns++;
        const usage = message.usage;
        if (usage) {
            this.usage.input += usage.input ?? 0;
            this.usage.output += usage.output ?? 0;
            this.usage.cacheRead += usage.cacheRead ?? 0;
            this.usage.cacheWrite += usage.cacheWrite ?? 0;
            this.usage.cost += usage.cost?.total ?? 0;
        }
        return extractText(message.content);
    }
}

class Semaphore {
    private inFlight = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly max: number) {}

    private async acquire(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throw new Error("Subagent cancelled while queued");
        if (this.inFlight < this.max) {
            this.inFlight++;
            return;
        }

        await new Promise<void>((resolve, reject) => {
            let waiter: (() => void) | undefined;
            const onAbort = () => {
                if (waiter) {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                }
                reject(new Error("Subagent cancelled while queued"));
            };
            waiter = () => {
                signal?.removeEventListener("abort", onAbort);
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
            next?.();
        }
    }
}

function createThrottledUpdate(fn: () => void): {
    trigger: () => void;
    flush: () => void;
    dispose: () => void;
} {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const emit = () => {
        last = Date.now();
        timer = undefined;
        fn();
    };

    return {
        trigger() {
            const remaining = UPDATE_THROTTLE_MS - (Date.now() - last);
            if (remaining <= 0) emit();
            else if (!timer) timer = setTimeout(emit, remaining);
        },
        flush() {
            if (timer) clearTimeout(timer);
            emit();
        },
        dispose() {
            if (timer) clearTimeout(timer);
            timer = undefined;
        },
    };
}

function terminalStatus(handle: RunHandle): "failed" | "cancelled" {
    return handle.cancelReason === "timeout" ? "failed" : "cancelled";
}

function cancellationSummary(handle: RunHandle): string {
    if (handle.cancelReason === "timeout") return "Subagent execution timed out.";
    if (handle.cancelReason === "shutdown") return "Subagent cancelled because the parent session shut down.";
    return "Subagent cancelled.";
}

function trimReport(report: StructuredReport): StructuredReport {
    return {
        status: report.status,
        summary: report.summary.trim(),
        evidence: report.evidence?.map((item) => item.trim()).filter(Boolean),
        verification: report.verification?.map((item) => ({
            command: item.command.trim(),
            exitCode: item.exitCode,
            summary: item.summary.trim(),
        })),
        unresolved: report.unresolved?.map((item) => item.trim()).filter(Boolean),
    };
}

export class SubagentManager {
    private readonly concurrency: Semaphore;
    private readonly executeMutex = new Semaphore(1);
    private readonly worktrees: WorktreeManager;
    private readonly runs = new Map<string, RunHandle>();
    private readonly activePromises = new Set<Promise<SubagentDetails>>();
    private readonly artifactDirs = new Set<string>();
    private disposed = false;

    constructor(
        private readonly pi: ExtensionAPI,
        readonly config: SubagentConfig,
    ) {
        this.concurrency = new Semaphore(config.maxConcurrency);
        this.worktrees = new WorktreeManager(pi);
    }

    private snapshot(
        handle: RunHandle,
        overrides: Partial<SubagentDetails> = {},
    ): SubagentDetails {
        return {
            mode: handle.request.mode,
            task: handle.request.task,
            status: handle.status,
            summary: overrides.summary ?? this.statusSummary(handle),
            model: handle.session?.model
                ? `${handle.session.model.provider}/${handle.session.model.id}`
                : undefined,
            durationMs: Date.now() - handle.startedAt,
            toolCount: handle.progress.toolCount,
            currentTools: Array.from(handle.progress.current.values()).map((item) => ({ ...item })),
            recentTools: handle.progress.recent.map((item) => ({ ...item })),
            usage: { ...handle.progress.usage },
            ...overrides,
        };
    }

    private statusSummary(handle: RunHandle): string {
        switch (handle.status) {
            case "queued":
                return "Waiting for a subagent concurrency slot.";
            case "preparing":
                return handle.request.mode === "execute"
                    ? "Preparing an isolated Git worktree."
                    : "Preparing an isolated AgentSession.";
            case "running":
                return "Subagent is running.";
            case "finalizing":
                return "Finalizing the subagent result.";
            default:
                return handle.lastAssistantText || "Subagent finished.";
        }
    }

    private emit(handle: RunHandle, onUpdate?: UpdateCallback): void {
        onUpdate?.(this.snapshot(handle));
    }

    private abortHandle(
        handle: RunHandle,
        reason: "parent" | "timeout" | "shutdown",
    ): void {
        if (!handle.cancelReason) handle.cancelReason = reason;
        if (!handle.controller.signal.aborted) {
            handle.controller.abort(new Error(reason));
        }
        if (handle.session?.isStreaming) {
            void handle.session.abort().catch(() => {});
        }
    }

    async run(
        toolCallId: string,
        request: RunRequest,
        ctx: ExtensionContext,
        signal: AbortSignal | undefined,
        onUpdate?: UpdateCallback,
    ): Promise<SubagentDetails> {
        if (this.disposed) throw new Error("Subagent manager is disposed");

        const handle: RunHandle = {
            id: toolCallId,
            request,
            status: "queued",
            startedAt: Date.now(),
            controller: new AbortController(),
            lastAssistantText: "",
            progress: new RunProgress(),
        };
        this.runs.set(toolCallId, handle);
        this.emit(handle, onUpdate);

        const onParentAbort = () => this.abortHandle(handle, "parent");
        if (signal?.aborted) onParentAbort();
        else signal?.addEventListener("abort", onParentAbort, { once: true });

        const runPromise = this.runWithLimits(handle, ctx, onUpdate);
        this.activePromises.add(runPromise);

        try {
            return await runPromise;
        } finally {
            signal?.removeEventListener("abort", onParentAbort);
            if (handle.timeout) clearTimeout(handle.timeout);
            this.runs.delete(toolCallId);
            this.activePromises.delete(runPromise);
        }
    }

    private runWithLimits(
        handle: RunHandle,
        ctx: ExtensionContext,
        onUpdate?: UpdateCallback,
    ): Promise<SubagentDetails> {
        const run = () =>
            this.concurrency.run(
                () => this.runActive(handle, ctx, onUpdate),
                handle.controller.signal,
            );

        return handle.request.mode === "execute"
            ? this.executeMutex.run(run, handle.controller.signal)
            : run();
    }

    private async runActive(
        handle: RunHandle,
        ctx: ExtensionContext,
        onUpdate?: UpdateCallback,
    ): Promise<SubagentDetails> {
        handle.timeout = setTimeout(
            () => this.abortHandle(handle, "timeout"),
            this.config.executionTimeoutMs,
        );
        handle.status = "preparing";
        this.emit(handle, onUpdate);

        let unsubscribe: (() => void) | undefined;
        let throttled: ReturnType<typeof createThrottledUpdate> | undefined;
        let patch: PatchResult | undefined;
        let webTools: ExaSdkToolBundle | undefined;

        try {
            if (handle.controller.signal.aborted) {
                return this.snapshot(handle, {
                    status: terminalStatus(handle),
                    summary: cancellationSummary(handle),
                });
            }

            const requestedCwd = path.resolve(ctx.cwd, handle.request.cwd ?? ".");
            const policy = MODE_POLICIES[handle.request.mode];
            let sessionCwd = requestedCwd;

            if (policy.usesWorktree) {
                handle.workspace = await this.worktrees.create(
                    requestedCwd,
                    handle.controller.signal,
                );
                sessionCwd = handle.workspace.cwd;
            } else {
                const stat = await fs.promises.stat(sessionCwd).catch(() => undefined);
                if (!stat?.isDirectory()) {
                    throw new Error(`inspect cwd is not an accessible directory: ${sessionCwd}`);
                }
            }

            if (!ctx.model) throw new Error("No active parent model is available for the subagent");

            let capturedReport: StructuredReport | undefined;
            const reportResultTool = defineTool({
                name: "report_result",
                label: "Report Result",
                description:
                    "Submit the final structured result for this delegated task. Call this alone after all investigation, edits, and verification are complete.",
                parameters: ReportSchema,
                async execute(_id, params) {
                    capturedReport = trimReport(params);
                    return {
                        content: [{ type: "text" as const, text: params.summary }],
                        details: params,
                        terminate: true,
                    };
                },
            });

            webTools = policy.loadsWebTools ? createExaSdkTools() : undefined;
            const settingsManager = SettingsManager.inMemory();
            const resourceLoader = new DefaultResourceLoader({
                cwd: sessionCwd,
                agentDir: getAgentDir(),
                settingsManager,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                appendSystemPromptOverride: () => [policy.systemPrompt],
            });
            await resourceLoader.reload();

            const extensionErrors = resourceLoader.getExtensions().errors;
            if (extensionErrors.length > 0) {
                throw new Error(
                    `Failed to load subagent resources: ${extensionErrors
                        .map((item) => `${item.path}: ${item.error}`)
                        .join("; ")}`,
                );
            }

            const { session } = await createAgentSession({
                cwd: sessionCwd,
                agentDir: getAgentDir(),
                model: ctx.model,
                thinkingLevel: this.pi.getThinkingLevel(),
                authStorage: ctx.modelRegistry.authStorage,
                modelRegistry: ctx.modelRegistry,
                tools: [...policy.tools, "report_result"],
                customTools: [...(webTools?.tools ?? []), reportResultTool],
                resourceLoader,
                sessionManager: SessionManager.inMemory(sessionCwd),
                settingsManager,
            });
            handle.session = session;

            const requiredTools = [...policy.tools, "report_result"];
            const activeTools = new Set(session.getActiveToolNames());
            const missingTools = requiredTools.filter((name) => !activeTools.has(name));
            if (missingTools.length > 0) {
                throw new Error(`Subagent tools failed to load: ${missingTools.join(", ")}`);
            }

            throttled = createThrottledUpdate(() => this.emit(handle, onUpdate));
            unsubscribe = session.subscribe((event) => {
                switch (event.type) {
                    case "tool_execution_start":
                        handle.progress.start(
                            event.toolCallId,
                            event.toolName,
                            (event.args ?? {}) as Record<string, unknown>,
                        );
                        throttled?.trigger();
                        break;
                    case "tool_execution_update":
                        throttled?.trigger();
                        break;
                    case "tool_execution_end":
                        handle.progress.finish(event.toolCallId, event.toolName, event.isError);
                        throttled?.trigger();
                        break;
                    case "message_end":
                        if (event.message.role === "assistant") {
                            const text = handle.progress.recordAssistant(event.message);
                            if (text) handle.lastAssistantText = text;
                            handle.agentError = event.message.errorMessage;
                        }
                        throttled?.trigger();
                        break;
                }
            });

            const abortSession = () => {
                if (session.isStreaming) void session.abort().catch(() => {});
            };
            handle.controller.signal.addEventListener("abort", abortSession, { once: true });

            if (handle.controller.signal.aborted) {
                await session.abort().catch(() => {});
                return this.snapshot(handle, {
                    status: terminalStatus(handle),
                    summary: cancellationSummary(handle),
                });
            }

            handle.status = "running";
            this.emit(handle, onUpdate);
            try {
                await session.prompt(handle.request.task, {
                    expandPromptTemplates: false,
                });
            } finally {
                handle.controller.signal.removeEventListener("abort", abortSession);
            }

            handle.report = capturedReport;
            if (handle.controller.signal.aborted) {
                return this.snapshot(handle, {
                    status: terminalStatus(handle),
                    summary: cancellationSummary(handle),
                });
            }

            handle.status = "finalizing";
            throttled.flush();

            if (handle.workspace) {
                patch = await handle.workspace.finalize(
                    this.config.maxOutputBytes,
                    handle.controller.signal,
                );
                if (patch.artifactDir) this.artifactDirs.add(patch.artifactDir);
            }

            const report = capturedReport;
            const sessionError = handle.agentError || session.state.errorMessage;
            let status: SubagentStatus;
            let summary: string;
            let unresolved: string[] | undefined;

            if (report) {
                status = report.status;
                summary = report.summary;
                unresolved = report.unresolved;
            } else if (sessionError) {
                status = "failed";
                summary = sessionError;
            } else {
                status = "partial";
                summary = handle.lastAssistantText || "Subagent ended without a structured report.";
                unresolved = ["The subagent did not call report_result."];
            }

            if (patch && !patch.appliesCleanly) {
                status = "blocked";
                unresolved = [
                    ...(unresolved ?? []),
                    `Generated patch no longer applies cleanly: ${patch.applyError ?? "unknown git apply error"}`,
                ];
            }

            handle.status = status;
            const summaryLimit = truncateHead(summary, {
                maxLines: 2_000,
                maxBytes: this.config.maxOutputBytes,
            });
            summary = summaryLimit.content || "(empty result)";
            if (summaryLimit.truncated) summary += "\n\n[Summary truncated]";

            return this.snapshot(handle, {
                status,
                summary,
                evidence: report?.evidence,
                verification: report?.verification,
                unresolved,
                changedFiles: patch?.changedFiles,
                patch: patch
                    ? {
                          path: patch.patchPath,
                          preview: patch.patchPreview,
                          bytes: patch.patchBytes,
                          appliesCleanly: patch.appliesCleanly,
                          applyError: patch.applyError,
                      }
                    : undefined,
                error: status === "failed" ? sessionError : undefined,
            });
        } catch (error) {
            if (handle.controller.signal.aborted) {
                handle.status = terminalStatus(handle);
                return this.snapshot(handle, {
                    status: handle.status,
                    summary: cancellationSummary(handle),
                    error:
                        handle.cancelReason === "timeout"
                            ? `Exceeded ${this.config.executionTimeoutMs}ms timeout`
                            : undefined,
                });
            }

            if (error instanceof WorktreeBlockedError) {
                handle.status = "blocked";
                return this.snapshot(handle, {
                    status: "blocked",
                    summary: error.message,
                    unresolved: [error.message],
                });
            }

            const message = error instanceof Error ? error.message : String(error);
            handle.status = "failed";
            return this.snapshot(handle, {
                status: "failed",
                summary: message,
                error: message,
            });
        } finally {
            throttled?.dispose();
            unsubscribe?.();
            if (handle.session) {
                if (handle.session.isStreaming) {
                    await handle.session.abort().catch(() => {});
                }
                handle.session.dispose();
                handle.session = undefined;
            }
            await webTools?.close().catch(() => {});
            if (handle.workspace) {
                const retainedArtifactDir = handle.workspace.retainedArtifactDir;
                if (retainedArtifactDir) this.artifactDirs.add(retainedArtifactDir);
                await handle.workspace.dispose();
                handle.workspace = undefined;
            }
            if (handle.timeout) {
                clearTimeout(handle.timeout);
                handle.timeout = undefined;
            }
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;

        for (const handle of this.runs.values()) {
            this.abortHandle(handle, "shutdown");
        }
        await Promise.allSettled(
            Array.from(this.runs.values()).map((handle) => handle.session?.abort()),
        );
        await Promise.allSettled(Array.from(this.activePromises));
        await Promise.allSettled(
            Array.from(this.artifactDirs).map((dir) =>
                fs.promises.rm(dir, { recursive: true, force: true }),
            ),
        );
        this.artifactDirs.clear();
    }
}

function appendList(lines: string[], heading: string, items: string[] | undefined): void {
    if (!items || items.length === 0) return;
    lines.push("", `${heading}:`);
    for (const item of items) lines.push(`- ${item}`);
}

export function formatSubagentResult(
    details: SubagentDetails,
    maxOutputBytes: number,
): string {
    const lines = [`Status: ${details.status}`, "", details.summary];

    appendList(lines, "Evidence", details.evidence);
    appendList(lines, "Changed files", details.changedFiles);

    if (details.verification && details.verification.length > 0) {
        lines.push("", "Verification:");
        for (const item of details.verification) {
            lines.push(`- \`${item.command}\` (exit ${item.exitCode}): ${item.summary}`);
        }
    }

    if (details.patch?.path) {
        lines.push(
            "",
            `Patch: ${details.patch.path} (${details.patch.bytes} bytes, ${
                details.patch.appliesCleanly ? "applies cleanly" : "does not apply cleanly"
            })`,
        );
    }
    appendList(lines, "Unresolved", details.unresolved);
    if (details.error) lines.push("", `Error: ${details.error}`);

    const output = lines.join("\n");
    const truncation = truncateHead(output, {
        maxLines: 2_000,
        maxBytes: maxOutputBytes,
    });
    if (!truncation.truncated) return truncation.content;
    return `${truncation.content}\n\n[Subagent result truncated: ${truncation.outputBytes}/${truncation.totalBytes} bytes]`;
}

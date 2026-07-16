import { StringEnum } from "@earendil-works/pi-ai";
import {
    type ExtensionAPI,
    getMarkdownTheme,
    keyHint,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
    formatSubagentResult,
    loadSubagentConfig,
    type SubagentDetails,
    SubagentManager,
    type SubagentStatus,
    type ToolActivity,
} from "./manager.ts";
import type { SubagentMode } from "./modes.ts";

const SubagentParams = Type.Object({
    mode: StringEnum(["inspect", "execute"] as const, {
        description:
            "inspect performs read-only investigation; execute modifies an isolated clean Git worktree and returns a patch",
    }),
    task: Type.String({
        minLength: 1,
        description:
            "Self-contained task brief including goals, relevant paths, constraints, and expected output",
    }),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory, resolved relative to the parent session cwd",
        }),
    ),
});

function formatTokens(value: number): string {
    if (value < 1_000) return String(value);
    if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
    if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
    return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1_000)}s`;
}

function isRunning(status: SubagentStatus): boolean {
    return status === "queued" || status === "preparing" || status === "running" || status === "finalizing";
}

function statusIcon(status: SubagentStatus, theme: any): string {
    if (isRunning(status)) return theme.fg("warning", "⟳");
    if (status === "completed") return theme.fg("success", "✓");
    if (status === "partial" || status === "blocked") return theme.fg("warning", "◐");
    return theme.fg("error", "✗");
}

function usageText(details: SubagentDetails): string {
    const parts: string[] = [];
    if (details.usage.turns) parts.push(`${details.usage.turns} turns`);
    if (details.usage.input) parts.push(`↑${formatTokens(details.usage.input)}`);
    if (details.usage.output) parts.push(`↓${formatTokens(details.usage.output)}`);
    if (details.usage.cacheRead) parts.push(`R${formatTokens(details.usage.cacheRead)}`);
    if (details.usage.cacheWrite) parts.push(`W${formatTokens(details.usage.cacheWrite)}`);
    if (details.usage.cost) parts.push(`$${details.usage.cost.toFixed(4)}`);
    return parts.join(" ");
}

function renderTool(activity: ToolActivity, theme: any): string {
    const marker = activity.status === "running" ? "▸" : activity.status === "failed" ? "✗" : " ";
    const color = activity.status === "running" ? "warning" : activity.status === "failed" ? "error" : "muted";
    const preview = activity.preview ? `: ${activity.preview}` : "";
    return theme.fg(color, `${marker} ${activity.name}${preview}`);
}

function addList(container: Container, title: string, items: string[] | undefined, theme: any): void {
    if (!items || items.length === 0) return;
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", `─── ${title} ───`), 0, 0));
    for (const item of items) container.addChild(new Text(`• ${item}`, 0, 0));
}

export default function subagentExtension(pi: ExtensionAPI) {
    const config = loadSubagentConfig();
    const manager = new SubagentManager(pi, config);

    pi.on("session_shutdown", async () => {
        await manager.dispose();
    });

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description:
            "Run one isolated delegated task. inspect is read-only and can research code or the web. execute edits a temporary detached worktree from a completely clean Git repository and returns a patch without changing the parent workspace. Emit multiple independent inspect calls in one turn for parallel work.",
        promptSnippet: "Run an isolated inspect or execute task",
        promptGuidelines: [
            "Use subagent only when context isolation or true parallelism has clear value; use ordinary tools directly for simple lookups or edits.",
            "Use subagent mode=inspect for read-only multi-file reconnaissance, external research, or independent review. The task must request factual evidence rather than delegate product decisions.",
            "Use subagent mode=execute only for a clear, self-contained implementation that needs no user interaction. execute requires a completely clean Git worktree, runs serially, and returns a patch for the parent to review and apply.",
            "Subagents receive no parent conversation context. Every subagent task must include its goal, relevant paths, constraints, expected output, and verification requirements.",
            "For independent inspect tasks, emit multiple subagent calls in the same turn. Keep dependent work sequential.",
            "The parent agent owns planning, user questions, patch application, review, and final verification.",
        ],
        parameters: SubagentParams,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const details = await manager.run(
                toolCallId,
                {
                    mode: params.mode as SubagentMode,
                    task: params.task,
                    cwd: params.cwd,
                },
                ctx,
                signal,
                (partial) => {
                    onUpdate?.({
                        content: [
                            {
                                type: "text",
                                text: `${partial.mode}: ${partial.summary}`,
                            },
                        ],
                        details: partial,
                    });
                },
            );

            return {
                content: [
                    {
                        type: "text",
                        text: formatSubagentResult(details, config.maxOutputBytes),
                    },
                ],
                details,
            };
        },

        renderCall(args, theme, context) {
            const mode = (args.mode ?? "inspect") as SubagentMode;
            if (!context.expanded) {
                const preview = (args.task ?? "")
                    .replace(/\s+/g, " ")
                    .slice(0, 80);
                return new Text(
                    `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", mode)}${preview ? ` ${theme.fg("dim", preview)}` : ""}`,
                    0,
                    0,
                );
            }

            const container =
                context.lastComponent instanceof Container
                    ? context.lastComponent
                    : new Container();
            container.clear();
            container.addChild(
                new Text(
                    `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", mode)}${args.cwd ? theme.fg("dim", ` (cwd: ${args.cwd})`) : ""}`,
                    0,
                    0,
                ),
            );
            if (args.task) {
                container.addChild(new Spacer(1));
                container.addChild(new Text(args.task, 0, 0));
            }
            return container;
        },

        renderResult(result, options, theme) {
            const details = result.details as SubagentDetails | undefined;
            if (!details) {
                const first = result.content[0];
                return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
            }

            const icon = statusIcon(details.status, theme);
            const header = `${icon} ${theme.fg("toolTitle", theme.bold(details.mode))} ${theme.fg("muted", `${details.status} · ${details.toolCount} tools · ${formatDuration(details.durationMs)}`)}`;
            const tools = [...details.recentTools, ...details.currentTools];
            const usage = usageText(details);

            if (!options.expanded) {
                const lines = [header];
                for (const activity of tools) lines.push(renderTool(activity, theme));
                if (!isRunning(details.status)) {
                    const summary = details.summary.split("\n").slice(0, 3).join("\n");
                    if (summary) lines.push("", summary);
                    if (details.changedFiles?.length) {
                        lines.push(theme.fg("muted", `${details.changedFiles.length} changed file(s)`));
                    }
                    if (details.patch?.path) {
                        lines.push(theme.fg("dim", `patch: ${details.patch.path}`));
                    }
                    lines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
                }
                if (usage) lines.push(theme.fg("dim", usage));
                return new Text(lines.join("\n"), 0, 0);
            }

            const container = new Container();
            container.addChild(new Text(header, 0, 0));
            for (const activity of tools) {
                container.addChild(new Text(renderTool(activity, theme), 0, 0));
            }
            if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));

            if (details.summary) {
                container.addChild(new Spacer(1));
                container.addChild(new Text(theme.fg("muted", "─── Summary ───"), 0, 0));
                container.addChild(
                    new Markdown(details.summary, 0, 0, getMarkdownTheme()),
                );
            }

            addList(container, "Evidence", details.evidence, theme);
            addList(container, "Changed files", details.changedFiles, theme);

            if (details.verification?.length) {
                container.addChild(new Spacer(1));
                container.addChild(new Text(theme.fg("muted", "─── Verification ───"), 0, 0));
                for (const item of details.verification) {
                    const color = item.exitCode === 0 ? "success" : "error";
                    container.addChild(
                        new Text(
                            `${theme.fg(color, item.exitCode === 0 ? "✓" : "✗")} ${item.command} — ${item.summary}`,
                            0,
                            0,
                        ),
                    );
                }
            }

            if (details.patch) {
                container.addChild(new Spacer(1));
                container.addChild(new Text(theme.fg("muted", "─── Patch ───"), 0, 0));
                const patchStatus = details.patch.appliesCleanly
                    ? theme.fg("success", "applies cleanly")
                    : theme.fg("error", "does not apply cleanly");
                container.addChild(
                    new Text(
                        `${details.patch.path ?? "(no patch)"} · ${details.patch.bytes} bytes · ${patchStatus}`,
                        0,
                        0,
                    ),
                );
            }

            addList(container, "Unresolved", details.unresolved, theme);
            if (details.error) {
                container.addChild(new Spacer(1));
                container.addChild(new Text(theme.fg("error", `Error: ${details.error}`), 0, 0));
            }
            return container;
        },
    });
}

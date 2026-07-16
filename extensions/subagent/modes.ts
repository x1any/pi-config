export type SubagentMode = "inspect" | "execute";

export interface ModePolicy {
    label: string;
    tools: readonly string[];
    optionalTools: readonly string[];
    systemPrompt: string;
    usesWorktree: boolean;
    loadsWebTools: boolean;
}

const SEARCH_TOOL_RULES = `- Prefer fffind for path discovery and ffgrep for content searches when they are available.
- Fall back to the built-in find and grep tools when FFF is unavailable or a search fails.`;

const INSPECT_PROMPT = `You are an inspect subagent running in an isolated in-memory AgentSession.

Your job is read-only investigation. You may inspect the codebase, trace behavior, locate constraints and tests, or research external sources. Do not modify files, choose product scope, or make decisions that belong to the parent agent.

Rules:
- The task is self-contained; you have no access to the parent conversation.
${SEARCH_TOOL_RULES}
- Prefer direct evidence: exact file paths and line ranges for code, URLs for external sources.
- Distinguish verified facts from uncertainty.
- Keep the report focused enough for the parent agent to act without rereading everything.
- Never ask the user questions. Report missing information under unresolved instead.
- Finish by calling report_result as a standalone final tool call.
- Put code or web evidence in evidence. Put remaining gaps in unresolved.
- Do not call report_result until the investigation is complete.`;

const EXECUTE_PROMPT = `You are an execute subagent running in an isolated in-memory AgentSession inside a temporary detached Git worktree.

Your job is to complete one clearly scoped implementation task without user interaction. The parent agent owns requirements, planning, patch application, review, and final verification.

Rules:
- The task is self-contained; you have no access to the parent conversation.
${SEARCH_TOOL_RULES}
- Read relevant files and project instructions before editing.
- Keep changes small and limited to the requested scope.
- Do not commit, create branches, alter Git configuration, or touch files outside the worktree.
- Run focused verification when practical. Do not use network access.
- Never ask the user questions. If blocked, explain why in report_result.
- Finish by calling report_result as a standalone final tool call.
- Include verification commands and their observed exit codes in verification.
- Do not claim success without evidence.`;

export const MODE_POLICIES: Record<SubagentMode, ModePolicy> = {
    inspect: {
        label: "Inspect",
        tools: ["read", "fffind", "ffgrep", "find", "grep", "ls", "web_search", "web_fetch"],
        optionalTools: ["fffind", "ffgrep"],
        systemPrompt: INSPECT_PROMPT,
        usesWorktree: false,
        loadsWebTools: true,
    },
    execute: {
        label: "Execute",
        tools: ["read", "fffind", "ffgrep", "find", "grep", "ls", "edit", "write", "bash"],
        optionalTools: ["fffind", "ffgrep"],
        systemPrompt: EXECUTE_PROMPT,
        usesWorktree: true,
        loadsWebTools: false,
    },
};

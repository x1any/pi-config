# pi-config

Personal Pi package for shared extensions and skills.

## Structure

```text
extensions/   # TypeScript/JavaScript Pi extensions
skills/       # Agent Skills directories containing SKILL.md
```

## Included extensions

| Extension | Type | Description |
|-----------|------|-------------|
| **subagent** | Tool | `subagent` tool — run isolated read-only `inspect` tasks or worktree-backed `execute` tasks |
| **context** | Command | `/context` — visualize session token usage as a colored grid with per-tool / per-role breakdown |
| **memory** | Feature | `/memory` (Alt+M) — persistent `MEMORY.md` project memory with toggle; agent auto-reads/updates |
| **ask-user-question** | Tool | `ask_user_question` tool — let the LLM ask you structured single/multi-choice or free-text questions |
| **exa** | Tool | `web_search` / `web_fetch` tools — Exa-powered web search via MCP |
| **btw** | Command | `/btw <question>` — ask a quick side question; answer shown in a temporary overlay, zero history cost |

## Included skills

| Skill | Description |
|-------|-------------|
| **orchestrator** | Top-level session orchestration rules for subagent routing, context hygiene, and implementation discipline |

## Local install

From this repository root:

```bash
npm install --legacy-peer-deps
pi install .
```

After editing resources, reload Pi:

```text
/reload
```

## Recommended Pi packages

This package only ships the local extensions and skills in this repository. Install these third-party Pi packages separately when you want the full setup:

```bash
pi install npm:@upstash/context7-pi
pi install npm:@davecodes/pi-dcp
pi install npm:@ff-labs/pi-fff
pi install npm:pi-simplify
```

Or keep them together in Pi's user `settings.json`:

```json
{
  "packages": [
    "git:github.com/x1any/pi-config",
    "npm:@upstash/context7-pi",
    "npm:@davecodes/pi-dcp",
    "npm:@ff-labs/pi-fff",
    "npm:pi-simplify"
  ]
}
```

For a local checkout, replace the first entry with your local package path, for example `"/path/to/pi-config"`.

For higher Context7 quotas, set `CONTEXT7_API_KEY` before launching Pi. Avoid installing the same third-party package twice, or Pi may try to register duplicate tools/commands.

## Git install from another machine

```bash
pi install git:github.com/x1any/pi-config
```

## Add a skill

```text
skills/my-skill/SKILL.md
```

`SKILL.md` should start with frontmatter:

```markdown
---
name: my-skill
description: Describe exactly when Pi should use this skill.
---

# My Skill

Instructions...
```

## Subagent modes

The `subagent` tool intentionally exposes only two fixed modes:

| Mode | Purpose | Workspace | Tools |
|---|---|---|---|
| `inspect` | Read-only codebase investigation, web research, or independent review | Current workspace | Read, FFF search (preferred), built-in search fallback, and Exa web tools |
| `execute` | One clear implementation task with focused verification | Temporary detached Git worktree | Read, FFF search (preferred), built-in search fallback, edit/write/bash |

When `@ff-labs/pi-fff` is active in the parent session, subagents load and prefer its `fffind` and `ffgrep` tools. The built-in `find` and `grep` tools remain available as fallback.

Subagents use an in-memory native Pi `AgentSession`; they do not inherit the parent conversation and cannot recursively invoke `subagent`. Provide a self-contained task brief.

Independent `inspect` calls can run in parallel. `execute` calls are serialized, require a completely clean Git repository (including no untracked files), and never modify the parent workspace directly. An execute result returns a patch path for the parent agent to review, apply, and verify.

Optional `extensions/subagent/config.json` settings (see `config.example.json`):

```json
{
  "maxConcurrency": 3,
  "executionTimeoutMs": 600000,
  "maxOutputBytes": 100000
}
```

## Add an extension

```text
extensions/my-extension.ts
```

Minimal extension:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello from pi-config!", "info");
    },
  });
}
```

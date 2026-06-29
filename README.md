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
| **subagents** | Tool | `subagent` tool — spawn isolated scout / researcher / worker sub-agents with parallel execution |
| **context** | Command | `/context` — visualize session token usage as a colored grid with per-tool / per-role breakdown |
| **memory** | Feature | `/memory` (Alt+M) — persistent `MEMORY.md` project memory with toggle; agent auto-reads/updates |
| **ask-user-question** | Tool | `ask_user_question` tool — let the LLM ask you structured single/multi-choice or free-text questions |
| **exa** | Tool | `web_search` / `web_fetch` tools — Exa-powered web search via MCP |
| **qmd** | Tool | `qmd_query` / `qmd_get` / `qmd_multi_get` / `qmd_status` — search and retrieve local QMD knowledge via MCP |
| **btw** | Command | `/btw <question>` — ask a quick side question; answer shown in a temporary overlay, zero history cost |

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

## QMD extension setup

The `qmd` extension exposes read-only tools for an existing QMD install. QMD indexing stays manual:

```bash
npm install -g @tobilu/qmd
qmd collection add ~/path/to/markdown --name myknowledge
qmd context add qmd://myknowledge "Describe this knowledge base"
qmd embed
qmd mcp --http --daemon
export PI_QMD_MCP_URL=http://localhost:8181/mcp
```

Useful environment variables:

- `PI_QMD_MCP_URL` — HTTP MCP endpoint; if unset, the extension starts `qmd mcp` over stdio on first use.
- `PI_QMD_COMMAND` — command for stdio mode, default `qmd`.
- `PI_QMD_INDEX` — optional named QMD index for stdio mode.
- `PI_QMD_TOOL_PREFIX` — tool prefix, default `qmd_`.
- `PI_QMD_ALLOW_REMOTE=1` — allow non-localhost MCP URLs (off by default because QMD MCP has no auth).
- `PI_QMD_GET_DEFAULT_MAX_LINES` / `PI_QMD_MULTI_GET_DEFAULT_MAX_LINES` / `PI_QMD_MULTI_GET_DEFAULT_MAX_BYTES` — default retrieval bounds.

Inside Pi, `/qmd-setup` shows setup commands and `/qmd-status` checks index health.

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

# pi-config

Personal Pi package for shared extensions and skills.

## Structure

```text
extensions/   # TypeScript/JavaScript Pi extensions
skills/       # Agent Skills directories containing SKILL.md
```

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
```

Or keep them together in Pi's user `settings.json`:

```json
{
  "packages": [
    "git:github.com:x1any/pi-config",
    "npm:@upstash/context7-pi",
    "npm:@davecodes/pi-dcp",
    "npm:@ff-labs/pi-fff"
  ]
}
```

For a local checkout, replace the first entry with your local package path, for example `"/path/to/pi-config"`.

For higher Context7 quotas, set `CONTEXT7_API_KEY` before launching Pi. Avoid installing the same third-party package twice, or Pi may try to register duplicate tools/commands.

## Git install from another machine

```bash
pi install git:github.com:x1any/pi-config
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

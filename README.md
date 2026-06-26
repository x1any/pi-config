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
pi install .
```

After editing resources, reload Pi:

```text
/reload
```

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

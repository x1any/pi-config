# QMD extension notice

This Pi extension integrates with the QMD MCP server from `tobi/qmd` (`@tobilu/qmd`).

QMD itself is not bundled here. Install and configure it separately:

```bash
npm install -g @tobilu/qmd
qmd collection add ~/path/to/markdown --name myknowledge
qmd embed
qmd mcp --http --daemon
```

Then set:

```bash
export PI_QMD_MCP_URL=http://localhost:8181/mcp
```

The extension exposes read-only search and retrieval tools only; it does not run QMD indexing or modify QMD configuration automatically.

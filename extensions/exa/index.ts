import {
    keyHint,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
    type ToolDefinition,
    type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type PiContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

type ExaTool = {
    name: "web_search" | "web_fetch";
    mcpName: "web_search_exa" | "web_fetch_exa";
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: any;
};

const DEFAULT_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_TOOLS = "web_search_exa,web_fetch_exa";
const TOOL_PREFIX = process.env.PI_EXA_TOOL_PREFIX ?? "";
const REQUEST_TIMEOUT_MS = Number(process.env.PI_EXA_TIMEOUT_MS ?? 120_000);

const EXA_TOOLS: ExaTool[] = [
    {
        name: "web_search",
        mcpName: "web_search_exa",
        label: "Web Search",
        description:
            "Search the web with Exa for current information, documentation, examples, news, and general web results.",
        promptSnippet:
            "Search the web with Exa for current information and relevant sources.",
        promptGuidelines: [
            "Use web_search for current web information, documentation, examples, news, and general web search.",
            "Prefer semantically rich natural-language queries with key entities, versions, dates, and constraints.",
        ],
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    minLength: 1,
                    description:
                        "Natural language search query. Use a semantically rich description of the ideal page, not just keywords.",
                },
                numResults: {
                    type: "number",
                    minimum: 1,
                    maximum: 100,
                    description:
                        "Number of search results to return (default: 10).",
                },
            },
            required: ["query"],
            additionalProperties: false,
        },
    },
    {
        name: "web_fetch",
        mcpName: "web_fetch_exa",
        label: "Web Fetch",
        description:
            "Read clean full-page content from one or more known URLs using Exa.",
        promptSnippet: "Fetch clean page content from URLs using Exa.",
        promptGuidelines: [
            "Use web_fetch to read clean full-page content from known URLs or URLs returned by web_search.",
        ],
        parameters: {
            type: "object",
            properties: {
                urls: {
                    type: "array",
                    items: { type: "string" },
                    description:
                        "URLs to read. Batch multiple URLs in one call.",
                },
                maxCharacters: {
                    type: "number",
                    minimum: 1,
                    description:
                        "Maximum characters to extract per page (default: 3000).",
                },
            },
            required: ["urls"],
            additionalProperties: false,
        },
    },
];

function buildMcpUrl(): URL {
    const url = new URL(process.env.PI_EXA_MCP_URL || DEFAULT_MCP_URL);

    // Exa's hosted MCP accepts the API key and enabled tools as query parameters.
    // If the user already put these in PI_EXA_MCP_URL, do not override them.
    if (process.env.EXA_API_KEY && !url.searchParams.has("exaApiKey")) {
        url.searchParams.set("exaApiKey", process.env.EXA_API_KEY);
    }
    const requestedTools = process.env.PI_EXA_TOOLS ?? DEFAULT_TOOLS;
    if (requestedTools && !url.searchParams.has("tools")) {
        url.searchParams.set("tools", requestedTools);
    }

    return url;
}

function publicUrl(url: URL): string {
    const clone = new URL(url.toString());
    if (clone.searchParams.has("exaApiKey"))
        clone.searchParams.set("exaApiKey", "***");
    return clone.toString();
}

function piToolName(toolName: string): string {
    return `${TOOL_PREFIX}${toolName}`;
}

function toPiContent(result: CallToolResult): PiContent[] {
    const content: PiContent[] = [];

    for (const item of result.content ?? []) {
        if (item.type === "text") {
            content.push({ type: "text", text: item.text });
        } else if (item.type === "image") {
            content.push({
                type: "image",
                data: item.data,
                mimeType: item.mimeType,
            });
        } else if (item.type === "resource") {
            const resource = item.resource;
            if ("text" in resource) {
                content.push({
                    type: "text",
                    text: `Resource: ${resource.uri}\n\n${resource.text}`,
                });
            } else {
                content.push({
                    type: "text",
                    text: `Resource: ${resource.uri}\nMIME: ${resource.mimeType ?? "application/octet-stream"}\nBase64 blob omitted from text output.`,
                });
            }
        } else if (item.type === "resource_link") {
            content.push({
                type: "text",
                text: [
                    `Resource link: ${item.name}`,
                    `URI: ${item.uri}`,
                    item.description
                        ? `Description: ${item.description}`
                        : undefined,
                ]
                    .filter(Boolean)
                    .join("\n"),
            });
        } else {
            content.push({ type: "text", text: JSON.stringify(item, null, 2) });
        }
    }

    if (content.length === 0) {
        content.push({ type: "text", text: JSON.stringify(result, null, 2) });
    }

    return content;
}

type SearchResultPreview = {
    title: string;
    url?: string;
    published?: string;
    author?: string;
    highlights: string[];
};

function getTextOutput(result: { content?: PiContent[] }): string {
    return (result.content ?? [])
        .map((item) => {
            if (item.type === "text") return item.text;
            return `[image: ${item.mimeType}]`;
        })
        .join("\n\n")
        .trim();
}

function getField(lines: string[], field: string): string | undefined {
    const prefix = `${field}:`;
    const line = lines.find((line) =>
        line.trimStart().toLowerCase().startsWith(prefix.toLowerCase()),
    );
    const value = line?.trimStart().slice(prefix.length).trim();
    return value || undefined;
}

function parseSearchResults(raw: string): SearchResultPreview[] {
    const normalized = raw.replace(/\r\n/g, "\n").trim();
    if (!normalized) return [];

    let blocks = normalized
        .split(/\n\s*---+\s*\n/g)
        .map((block) => block.trim())
        .filter(Boolean);

    if (blocks.length <= 1) {
        const titleMatches = [...normalized.matchAll(/^Title:[^\S\n]*/gim)];
        if (titleMatches.length > 1) {
            blocks = titleMatches.map((match, index) => {
                const start = match.index ?? 0;
                const end = titleMatches[index + 1]?.index;
                return normalized.slice(start, end).trim();
            });
        }
    }

    return blocks
        .map((block): SearchResultPreview | undefined => {
            const lines = block.split("\n").map((line) => line.trimEnd());
            const title = getField(lines, "Title");
            const url = getField(lines, "URL");
            if (!title && !url) return undefined;

            const highlightsIndex = lines.findIndex((line) =>
                /^Highlights:\s*$/i.test(line.trim()),
            );
            const highlights =
                highlightsIndex >= 0
                    ? lines
                          .slice(highlightsIndex + 1)
                          .map((line) => line.trim())
                          .filter(Boolean)
                    : [];

            const result: SearchResultPreview = {
                title: title || url || "Untitled result",
                highlights,
            };
            if (url) result.url = url;

            const published = getField(lines, "Published");
            if (published) result.published = published;

            const author = getField(lines, "Author");
            if (author) result.author = author;

            return result;
        })
        .filter((result): result is SearchResultPreview => Boolean(result));
}

function ellipsize(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function usefulHighlight(result: SearchResultPreview): string | undefined {
    return result.highlights.find(
        (line) =>
            line !== "..." &&
            line !== "…" &&
            !/^(Title|URL|Published|Author):/i.test(line),
    );
}

function expandHint(): string {
    try {
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "Ctrl+O to expand";
    }
}

function formatSearchCall(
    args: { query?: string; numResults?: number },
    registeredName: string,
    theme: Theme,
): string {
    let text = theme.fg("toolTitle", theme.bold(`${registeredName} `));
    text += theme.fg("accent", ellipsize(args.query || "", 90));
    if (args.numResults !== undefined)
        text += theme.fg("dim", ` (${args.numResults} results)`);
    return text;
}

function formatSearchResult(
    result: { content?: PiContent[]; isError?: boolean },
    options: ToolRenderResultOptions,
    theme: Theme,
    args: { query?: string },
): string {
    if (options.isPartial) return theme.fg("warning", "Searching...");

    const output = getTextOutput(result);
    if (!output) return theme.fg("dim", "No search output");
    if (result.isError)
        return theme.fg("error", output.split("\n")[0] || "Search failed");

    const parsed = parseSearchResults(output);
    if (parsed.length === 0) {
        const lines = output.split("\n");
        const maxLines = options.expanded ? lines.length : 12;
        let text = theme.fg("success", "Search complete");
        text += `\n${lines
            .slice(0, maxLines)
            .map((line) => theme.fg("toolOutput", line))
            .join("\n")}`;
        if (!options.expanded && lines.length > maxLines) {
            text +=
                theme.fg(
                    "dim",
                    `\n... ${lines.length - maxLines} more lines (`,
                ) +
                expandHint() +
                theme.fg("dim", ")");
        }
        return text;
    }

    let text = theme.fg(
        "success",
        `✓ ${parsed.length} search result${parsed.length === 1 ? "" : "s"}`,
    );
    if (args.query)
        text += theme.fg("dim", ` for "${ellipsize(args.query, 80)}"`);
    if (!options.expanded)
        text += theme.fg("dim", " (") + expandHint() + theme.fg("dim", ")");

    const display = options.expanded ? parsed : parsed.slice(0, 3);
    for (const [index, item] of display.entries()) {
        text += `\n${theme.fg("accent", `${index + 1}. ${ellipsize(item.title, options.expanded ? 140 : 100)}`)}`;
        if (item.url) text += `\n   ${theme.fg("dim", item.url)}`;

        if (options.expanded) {
            const meta = [
                item.published && item.published !== "N/A"
                    ? `Published: ${item.published}`
                    : undefined,
                item.author && item.author !== "N/A"
                    ? `Author: ${item.author}`
                    : undefined,
            ]
                .filter(Boolean)
                .join(" · ");
            if (meta) text += `\n   ${theme.fg("muted", meta)}`;
            const highlights = item.highlights
                .filter((line) => line !== "..." && line !== "…")
                .slice(0, 8);
            for (const highlight of highlights)
                text += `\n   ${theme.fg("toolOutput", highlight)}`;
        } else {
            const highlight = usefulHighlight(item);
            if (highlight)
                text += `\n   ${theme.fg("muted", ellipsize(highlight, 120))}`;
        }
    }

    if (!options.expanded && parsed.length > display.length) {
        text += theme.fg(
            "dim",
            `\n... ${parsed.length - display.length} more result${parsed.length - display.length === 1 ? "" : "s"}`,
        );
    }

    return text;
}

type FetchPagePreview = {
    title: string;
    url?: string;
    bodyLines: string[];
    charCount: number;
    lineCount: number;
};

function formatCount(value: number, unit: string): string {
    return `${value.toLocaleString()} ${unit}`;
}

function parseFetchPages(raw: string, urls?: string[]): FetchPagePreview[] {
    const normalized = raw.replace(/\r\n/g, "\n").trim();
    if (!normalized) return [];

    const matches = [...normalized.matchAll(/^#\s+(.+)\nURL:\s*(.+)$/gm)];
    if (matches.length === 0) {
        const lines = normalized.split("\n");
        return [
            {
                title: urls?.[0] || "Fetched content",
                url: urls?.[0],
                bodyLines: lines,
                charCount: normalized.length,
                lineCount: lines.length,
            },
        ];
    }

    return matches.map((match, index) => {
        const start = match.index ?? 0;
        const end = matches[index + 1]?.index;
        const block = normalized.slice(start, end).trim();
        const lines = block.split("\n");
        const bodyLines = lines.slice(2);
        return {
            title: match[1]?.trim() || match[2]?.trim() || "Fetched page",
            url: match[2]?.trim(),
            bodyLines,
            charCount: block.length,
            lineCount: lines.length,
        };
    });
}

function fetchPreviewLines(page: FetchPagePreview, limit: number): string[] {
    const normalizedTitle = page.title
        .replace(/^#+\s*/, "")
        .trim()
        .toLowerCase();
    return page.bodyLines
        .map((line) => line.trim())
        .filter((line) => {
            if (!line || line === "---" || line === "...") return false;
            const withoutHeading = line
                .replace(/^#+\s*/, "")
                .trim()
                .toLowerCase();
            return withoutHeading !== normalizedTitle;
        })
        .slice(0, limit);
}

function formatFetchCall(
    args: { urls?: string[]; maxCharacters?: number },
    registeredName: string,
    theme: Theme,
): string {
    const urls = args.urls ?? [];
    let text = theme.fg("toolTitle", theme.bold(`${registeredName} `));
    if (urls.length === 0) {
        text += theme.fg("dim", "no URLs");
    } else if (urls.length === 1) {
        text += theme.fg("accent", ellipsize(urls[0] || "", 100));
    } else {
        text += theme.fg("accent", `${urls.length} URLs`);
        text += theme.fg("dim", ` (${ellipsize(urls[0] || "", 80)} …)`);
    }
    if (args.maxCharacters !== undefined)
        text += theme.fg("dim", ` (max ${args.maxCharacters} chars)`);
    return text;
}

function formatFetchResult(
    result: { content?: PiContent[]; isError?: boolean },
    options: ToolRenderResultOptions,
    theme: Theme,
    args: { urls?: string[] },
): string {
    if (options.isPartial) return theme.fg("warning", "Fetching...");

    const output = getTextOutput(result);
    if (!output) return theme.fg("dim", "No fetched content");
    if (result.isError)
        return theme.fg("error", output.split("\n")[0] || "Fetch failed");

    const pages = parseFetchPages(output, args.urls);
    const pageCount = pages.length || args.urls?.length || 1;
    let text = theme.fg(
        "success",
        `✓ fetched ${pageCount} page${pageCount === 1 ? "" : "s"}`,
    );
    text += theme.fg(
        "dim",
        ` (${formatCount(output.length, "chars")}, ${formatCount(output.split("\n").length, "lines")}`,
    );
    if (!options.expanded) text += theme.fg("dim", ", ") + expandHint();
    text += theme.fg("dim", ")");

    if (options.expanded) {
        text += `\n${output
            .split("\n")
            .map((line) => theme.fg("toolOutput", line))
            .join("\n")}`;
        return text;
    }

    const display = pages.slice(0, 3);
    for (const [index, page] of display.entries()) {
        text += `\n${theme.fg("accent", `${index + 1}. ${ellipsize(page.title, 100)}`)}`;
        if (page.url) text += `\n   ${theme.fg("dim", page.url)}`;
        text += `\n   ${theme.fg("muted", `${formatCount(page.charCount, "chars")}, ${formatCount(page.lineCount, "lines")}`)}`;
        for (const line of fetchPreviewLines(page, 3)) {
            text += `\n   ${theme.fg("toolOutput", ellipsize(line, 120))}`;
        }
    }

    if (pages.length > display.length) {
        text += theme.fg(
            "dim",
            `\n... ${pages.length - display.length} more page${pages.length - display.length === 1 ? "" : "s"}`,
        );
    }

    return text;
}

class ExaMcpBridge {
    private client: Client | undefined;
    private transport: StreamableHTTPClientTransport | undefined;
    private connecting: Promise<Client> | undefined;
    readonly url = buildMcpUrl();

    async getClient(): Promise<Client> {
        if (this.client) return this.client;
        if (this.connecting) return this.connecting;

        this.connecting = (async () => {
            const client = new Client({ name: "exa", version: "0.1.0" });
            const transport = new StreamableHTTPClientTransport(this.url);
            await client.connect(transport);
            this.client = client;
            this.transport = transport;
            this.connecting = undefined;
            return client;
        })().catch((error) => {
            this.client = undefined;
            this.transport = undefined;
            this.connecting = undefined;
            throw error;
        });

        return this.connecting;
    }

    async callTool(
        name: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<CallToolResult> {
        try {
            const client = await this.getClient();
            return (await client.callTool(
                { name, arguments: args },
                undefined,
                {
                    signal,
                    timeout: REQUEST_TIMEOUT_MS,
                    resetTimeoutOnProgress: true,
                },
            )) as CallToolResult;
        } catch (error) {
            // If the HTTP MCP session went stale, reconnect once and retry.
            if (signal?.aborted) throw error;
            await this.close();
            const client = await this.getClient();
            return (await client.callTool(
                { name, arguments: args },
                undefined,
                {
                    signal,
                    timeout: REQUEST_TIMEOUT_MS,
                    resetTimeoutOnProgress: true,
                },
            )) as CallToolResult;
        }
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        this.transport = undefined;
        this.connecting = undefined;
        await client?.close().catch(() => undefined);
    }
}

export interface ExaSdkToolBundle {
    tools: ToolDefinition[];
    close(): Promise<void>;
}

/**
 * Create standalone Exa tool definitions for an SDK AgentSession.
 * The caller owns the returned bundle and must call close() when the session ends.
 */
export function createExaSdkTools(): ExaSdkToolBundle {
    const bridge = new ExaMcpBridge();
    const tools: ToolDefinition[] = EXA_TOOLS.map((tool) => ({
        // SDK subagents use stable private names even when the interactive Exa
        // extension is configured with PI_EXA_TOOL_PREFIX.
        name: tool.name,
        label: tool.label,
        description: tool.description,
        promptSnippet: tool.promptSnippet,
        promptGuidelines: tool.promptGuidelines,
        parameters: tool.parameters,
        executionMode: "parallel",
        async execute(_toolCallId, params, signal, onUpdate) {
            onUpdate?.({
                content: [
                    {
                        type: "text",
                        text: `Calling exa tool ${tool.name}...`,
                    },
                ],
                details: {},
            });
            const result = await bridge.callTool(
                tool.mcpName,
                params as Record<string, unknown>,
                signal,
            );
            const content = toPiContent(result);
            if (result.isError) {
                const message = content
                    .filter((item): item is { type: "text"; text: string } => item.type === "text")
                    .map((item) => item.text)
                    .join("\n");
                throw new Error(message || `Exa tool ${tool.name} failed`);
            }
            return {
                content,
                details: result,
            };
        },
    }));

    return {
        tools,
        close: () => bridge.close(),
    };
}

function registerStatusCommand(
    pi: ExtensionAPI,
    bridge: ExaMcpBridge,
    getError: () => unknown,
) {
    pi.registerCommand("exa-status", {
        description: "Show exa extension status",
        handler: async (_args, ctx) => {
            const tools = EXA_TOOLS.map((tool) => piToolName(tool.name));
            const error = getError();
            ctx.ui.notify(
                [
                    "exa: loaded",
                    `URL: ${publicUrl(bridge.url)}`,
                    `Tools: ${tools.join(", ")}`,
                    error
                        ? `Last error: ${error instanceof Error ? error.message : String(error)}`
                        : undefined,
                    process.env.EXA_API_KEY
                        ? "Using EXA_API_KEY from environment."
                        : "No EXA_API_KEY set; using Exa hosted MCP without an explicit key.",
                ]
                    .filter(Boolean)
                    .join("\n"),
                "info",
            );
        },
    });
}

export default async function exaExtension(pi: ExtensionAPI) {
    const bridge = new ExaMcpBridge();
    let lastError: unknown;

    registerStatusCommand(pi, bridge, () => lastError);

    for (const tool of EXA_TOOLS) {
        const registeredName = piToolName(tool.name);
        const toolRenderers =
            tool.name === "web_search"
                ? {
                      renderCall(
                          args: unknown,
                          theme: Theme,
                          context: { lastComponent?: unknown },
                      ) {
                          const text =
                              (context.lastComponent as Text | undefined) ??
                              new Text("", 0, 0);
                          text.setText(
                              formatSearchCall(
                                  (args ?? {}) as {
                                      query?: string;
                                      numResults?: number;
                                  },
                                  registeredName,
                                  theme,
                              ),
                          );
                          return text;
                      },
                      renderResult(
                          result: unknown,
                          options: ToolRenderResultOptions,
                          theme: Theme,
                          context: {
                              args?: unknown;
                              lastComponent?: unknown;
                          },
                      ) {
                          const text =
                              (context.lastComponent as Text | undefined) ??
                              new Text("", 0, 0);
                          text.setText(
                              formatSearchResult(
                                  result as {
                                      content?: PiContent[];
                                      isError?: boolean;
                                  },
                                  options,
                                  theme,
                                  (context.args ?? {}) as { query?: string },
                              ),
                          );
                          return text;
                      },
                  }
                : tool.name === "web_fetch"
                  ? {
                        renderCall(
                            args: unknown,
                            theme: Theme,
                            context: { lastComponent?: unknown },
                        ) {
                            const text =
                                (context.lastComponent as Text | undefined) ??
                                new Text("", 0, 0);
                            text.setText(
                                formatFetchCall(
                                    (args ?? {}) as {
                                        urls?: string[];
                                        maxCharacters?: number;
                                    },
                                    registeredName,
                                    theme,
                                ),
                            );
                            return text;
                        },
                        renderResult(
                            result: unknown,
                            options: ToolRenderResultOptions,
                            theme: Theme,
                            context: {
                                args?: unknown;
                                lastComponent?: unknown;
                            },
                        ) {
                            const text =
                                (context.lastComponent as Text | undefined) ??
                                new Text("", 0, 0);
                            text.setText(
                                formatFetchResult(
                                    result as {
                                        content?: PiContent[];
                                        isError?: boolean;
                                    },
                                    options,
                                    theme,
                                    (context.args ?? {}) as { urls?: string[] },
                                ),
                            );
                            return text;
                        },
                    }
                  : {};

        pi.registerTool({
            name: registeredName,
            label: tool.label,
            description: tool.description,
            promptSnippet: tool.promptSnippet,
            promptGuidelines: tool.promptGuidelines,
            parameters: tool.parameters,
            executionMode: "parallel",
            async execute(
                _toolCallId,
                params,
                signal,
                onUpdate,
                _ctx: ExtensionContext,
            ) {
                onUpdate?.({
                    content: [
                        {
                            type: "text",
                            text: `Calling exa tool ${registeredName}...`,
                        },
                    ],
                    details: {},
                });
                try {
                    const result = await bridge.callTool(
                        tool.mcpName,
                        params as Record<string, unknown>,
                        signal,
                    );
                    return {
                        content: toPiContent(result),
                        details: result,
                        isError: Boolean(result.isError),
                    };
                } catch (error) {
                    lastError = error;
                    throw error;
                }
            },
            ...toolRenderers,
        });
    }

    pi.on("session_shutdown", async () => {
        await bridge.close();
    });
}

import {
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
    parameters: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MCP_URL = "https://mcp.exa.ai/mcp";
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

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function buildMcpUrl(): URL {
    const url = new URL(process.env.PI_EXA_MCP_URL || DEFAULT_MCP_URL);
    if (process.env.EXA_API_KEY && !url.searchParams.has("exaApiKey")) {
        url.searchParams.set("exaApiKey", process.env.EXA_API_KEY);
    }
    const tools = process.env.PI_EXA_TOOLS;
    if (tools && !url.searchParams.has("tools")) {
        url.searchParams.set("tools", tools);
    }
    return url;
}

function publicUrl(url: URL): string {
    const clone = new URL(url.toString());
    if (clone.searchParams.has("exaApiKey"))
        clone.searchParams.set("exaApiKey", "***");
    return clone.toString();
}

function piToolName(name: string): string {
    return `${TOOL_PREFIX}${name}`;
}

// ---------------------------------------------------------------------------
// MCP → Pi content conversion
// ---------------------------------------------------------------------------

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
                    text: `Resource: ${resource.uri}\nMIME: ${resource.mimeType ?? "application/octet-stream"}\nBase64 blob omitted.`,
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

// ---------------------------------------------------------------------------
// MCP bridge
// ---------------------------------------------------------------------------

class ExaMcpBridge {
    private client: Client | undefined;
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
            this.connecting = undefined;
            return client;
        })().catch((error) => {
            this.client = undefined;
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
            if (signal?.aborted) throw error;
            // Stale session → reconnect once and retry.
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
        this.connecting = undefined;
        await client?.close().catch(() => undefined);
    }
}

// ---------------------------------------------------------------------------
// Shared tool execute factory
// ---------------------------------------------------------------------------

type ExecuteFn = (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (
        update: { content: PiContent[]; details: Record<string, unknown> },
    ) => void,
) => Promise<{ content: PiContent[]; details: Record<string, unknown> }>;

function makeExecute(
    bridge: ExaMcpBridge,
    tool: ExaTool,
    onError?: (error: unknown) => void,
): ExecuteFn {
    return async (_toolCallId, params, signal, onUpdate) => {
        onUpdate?.({
            content: [
                {
                    type: "text",
                    text: `Calling ${tool.mcpName}...`,
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
            const content = toPiContent(result);
            if (result.isError) {
                const message = content
                    .filter(
                        (
                            item,
                        ): item is { type: "text"; text: string } =>
                            item.type === "text",
                    )
                    .map((item) => item.text)
                    .join("\n");
                throw new Error(message || `Exa tool ${tool.mcpName} failed`);
            }
            const details = result as unknown as Record<string, unknown>;
            return { content, details };
        } catch (error) {
            onError?.(error);
            throw error;
        }
    };
}

// ---------------------------------------------------------------------------
// SDK export
// ---------------------------------------------------------------------------

export interface ExaSdkToolBundle {
    tools: import("@earendil-works/pi-coding-agent").ToolDefinition[];
    close(): Promise<void>;
}

/**
 * Create standalone Exa tool definitions for an SDK AgentSession.
 * The caller owns the returned bundle and must call close() when the session ends.
 */
export function createExaSdkTools(): ExaSdkToolBundle {
    const bridge = new ExaMcpBridge();

    const tools = EXA_TOOLS.map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        promptSnippet: tool.promptSnippet,
        promptGuidelines: tool.promptGuidelines,
        parameters: tool.parameters,
        executionMode: "parallel" as const,
        execute: makeExecute(bridge, tool),
    }));

    return {
        tools: tools as import("@earendil-works/pi-coding-agent").ToolDefinition[],
        close: () => bridge.close(),
    };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function exaExtension(pi: ExtensionAPI) {
    const bridge = new ExaMcpBridge();
    let lastError: unknown;

    // /exa-status command
    pi.registerCommand("exa-status", {
        description: "Show exa extension status",
        handler: async (_args, ctx) => {
            const tools = EXA_TOOLS.map((tool) => piToolName(tool.name));
            ctx.ui.notify(
                [
                    "exa: loaded",
                    `URL: ${publicUrl(bridge.url)}`,
                    `Tools: ${tools.join(", ")}`,
                    lastError
                        ? `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
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

    for (const tool of EXA_TOOLS) {
        pi.registerTool({
            name: piToolName(tool.name),
            label: tool.label,
            description: tool.description,
            promptSnippet: tool.promptSnippet,
            promptGuidelines: tool.promptGuidelines,
            parameters: tool.parameters,
            executionMode: "parallel",
            execute: makeExecute(bridge, tool, (error) => {
                lastError = error;
            }),
        });
    }

    pi.on("session_shutdown", async () => {
        await bridge.close();
    });
}

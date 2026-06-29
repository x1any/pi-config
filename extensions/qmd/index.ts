import type {
    ExtensionAPI,
    ExtensionContext,
    TruncationResult,
} from "@earendil-works/pi-coding-agent";
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_GET_MAX_LINES = 400;
const DEFAULT_MULTI_GET_MAX_LINES = 200;
const DEFAULT_MULTI_GET_MAX_BYTES = 64 * 1024;

const TOOL_PREFIX = process.env.PI_QMD_TOOL_PREFIX ?? "qmd_";

type QmdMcpTool = "query" | "get" | "multi_get" | "status";

type PiContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

type QmdConfig =
    | {
          mode: "http";
          url: URL;
          timeoutMs: number;
          getDefaultMaxLines?: number;
          multiGetDefaultMaxLines?: number;
          multiGetDefaultMaxBytes?: number;
      }
    | {
          mode: "stdio";
          command: string;
          args: string[];
          timeoutMs: number;
          getDefaultMaxLines?: number;
          multiGetDefaultMaxLines?: number;
          multiGetDefaultMaxBytes?: number;
      };

interface ContentSummary {
    type: string;
    textLength?: number;
    lineCount?: number;
    preview?: string;
    uri?: string;
    name?: string;
    title?: string;
    mimeType?: string;
}

type TruncationSummary = Omit<TruncationResult, "content">;

interface QmdToolDetails {
    qmdTool: QmdMcpTool;
    args: Record<string, unknown>;
    isError: boolean;
    transport: string;
    structuredContent?: unknown;
    contentSummary: ContentSummary[];
    truncation?: TruncationSummary;
}

function piToolName(name: string): string {
    return `${TOOL_PREFIX}${name}`;
}

function parseBoolean(value: string | undefined): boolean {
    return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function parsePositiveInt(value: string | undefined, fallback: number | undefined): number | undefined {
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.floor(parsed);
}

function isLocalHost(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function buildConfig(): QmdConfig {
    const timeoutMs = parsePositiveInt(process.env.PI_QMD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
    const getDefaultMaxLines = parsePositiveInt(process.env.PI_QMD_GET_DEFAULT_MAX_LINES, DEFAULT_GET_MAX_LINES);
    const multiGetDefaultMaxLines = parsePositiveInt(
        process.env.PI_QMD_MULTI_GET_DEFAULT_MAX_LINES,
        DEFAULT_MULTI_GET_MAX_LINES,
    );
    const multiGetDefaultMaxBytes = parsePositiveInt(
        process.env.PI_QMD_MULTI_GET_DEFAULT_MAX_BYTES,
        DEFAULT_MULTI_GET_MAX_BYTES,
    );

    const mcpUrl = process.env.PI_QMD_MCP_URL?.trim();
    if (mcpUrl) {
        const url = new URL(mcpUrl);
        if (!/^https?:$/.test(url.protocol)) {
            throw new Error(`PI_QMD_MCP_URL must be http(s), got: ${url.protocol}`);
        }
        if (!parseBoolean(process.env.PI_QMD_ALLOW_REMOTE) && !isLocalHost(url.hostname)) {
            throw new Error(
                "PI_QMD_MCP_URL must point to localhost unless PI_QMD_ALLOW_REMOTE=1 is set. QMD MCP has no built-in authentication.",
            );
        }
        return { mode: "http", url, timeoutMs, getDefaultMaxLines, multiGetDefaultMaxLines, multiGetDefaultMaxBytes };
    }

    const command = process.env.PI_QMD_COMMAND?.trim() || "qmd";
    const args: string[] = [];
    const index = process.env.PI_QMD_INDEX?.trim();
    if (index) args.push("--index", index);
    args.push("mcp");

    return { mode: "stdio", command, args, timeoutMs, getDefaultMaxLines, multiGetDefaultMaxLines, multiGetDefaultMaxBytes };
}

function publicUrl(url: URL): string {
    const clone = new URL(url.toString());
    clone.username = "";
    clone.password = "";
    for (const key of clone.searchParams.keys()) {
        if (/(key|token|secret|password)/i.test(key)) clone.searchParams.set(key, "***");
    }
    return clone.toString();
}

function transportDescription(config: QmdConfig): string {
    if (config.mode === "http") return `HTTP ${publicUrl(config.url)}`;
    return `stdio ${config.command} ${config.args.join(" ")}`;
}

class QmdMcpBridge {
    private client: Client | undefined;
    private transport: StreamableHTTPClientTransport | StdioClientTransport | undefined;
    private connecting: Promise<Client> | undefined;
    readonly config: QmdConfig;

    constructor(config = buildConfig()) {
        this.config = config;
    }

    describe(): string {
        return transportDescription(this.config);
    }

    async getClient(): Promise<Client> {
        if (this.client) return this.client;
        if (this.connecting) return this.connecting;

        this.connecting = (async () => {
            const client = new Client({ name: "pi-qmd", version: "0.1.0" });
            const transport =
                this.config.mode === "http"
                    ? new StreamableHTTPClientTransport(this.config.url)
                    : new StdioClientTransport({
                          command: this.config.command,
                          args: this.config.args,
                      });

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

    async callTool(name: QmdMcpTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
        try {
            const client = await this.getClient();
            return (await client.callTool(
                { name, arguments: args },
                undefined,
                {
                    signal,
                    timeout: this.config.timeoutMs,
                    resetTimeoutOnProgress: true,
                },
            )) as CallToolResult;
        } catch (error) {
            if (signal?.aborted) throw error;

            // MCP HTTP sessions and stdio subprocesses can go stale. Reconnect once.
            await this.close();
            const client = await this.getClient();
            return (await client.callTool(
                { name, arguments: args },
                undefined,
                {
                    signal,
                    timeout: this.config.timeoutMs,
                    resetTimeoutOnProgress: true,
                },
            )) as CallToolResult;
        }
    }

    async close(): Promise<void> {
        const client = this.client;
        const transport = this.transport;
        this.client = undefined;
        this.transport = undefined;
        this.connecting = undefined;
        await client?.close().catch(() => undefined);
        if (!client) await transport?.close().catch(() => undefined);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareQueryArguments(args: unknown): any {
    if (!isRecord(args)) return args;
    const next: Record<string, unknown> = { ...args };
    const legacyCollection = next.collection;
    if (next.collections === undefined && legacyCollection !== undefined) {
        if (typeof legacyCollection === "string" && legacyCollection.trim()) {
            next.collections = [legacyCollection.trim()];
        } else if (Array.isArray(legacyCollection)) {
            next.collections = legacyCollection;
        }
    }
    delete next.collection;
    return next;
}

function prepareGetArguments(args: unknown): any {
    if (!isRecord(args)) return args;
    const next: Record<string, unknown> = { ...args };
    if (next.file === undefined && typeof next.path === "string") {
        next.file = next.path;
    }
    delete next.path;
    delete next.full;
    return next;
}

function withDefaults(tool: QmdMcpTool, params: Record<string, unknown>, config: QmdConfig): Record<string, unknown> {
    const next: Record<string, unknown> = { ...params };
    if (tool === "get" && next.maxLines === undefined && config.getDefaultMaxLines !== undefined) {
        next.maxLines = config.getDefaultMaxLines;
    }
    if (tool === "multi_get") {
        if (next.maxLines === undefined && config.multiGetDefaultMaxLines !== undefined) {
            next.maxLines = config.multiGetDefaultMaxLines;
        }
        if (next.maxBytes === undefined && config.multiGetDefaultMaxBytes !== undefined) {
            next.maxBytes = config.multiGetDefaultMaxBytes;
        }
    }
    return next;
}

function preview(text: string, maxLength = 180): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function lineCount(text: string): number {
    if (!text) return 0;
    return text.split("\n").length;
}

function formatUnknown(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function contentItemToText(item: any): string {
    if (!item) return "";

    if (item.type === "text") {
        return String(item.text ?? "");
    }

    if (item.type === "resource") {
        const resource = item.resource ?? {};
        const header = [
            resource.uri ? `Resource: ${resource.uri}` : undefined,
            resource.name ? `Name: ${resource.name}` : undefined,
            resource.title ? `Title: ${resource.title}` : undefined,
            resource.mimeType ? `MIME: ${resource.mimeType}` : undefined,
        ]
            .filter(Boolean)
            .join("\n");

        if (typeof resource.text === "string") {
            return header ? `${header}\n\n${resource.text}` : resource.text;
        }

        return `${header || "Resource"}\n\n[Binary or non-text resource omitted]`;
    }

    if (item.type === "resource_link") {
        return [
            `Resource link: ${item.name ?? item.uri ?? "untitled"}`,
            item.uri ? `URI: ${item.uri}` : undefined,
            item.description ? `Description: ${item.description}` : undefined,
        ]
            .filter(Boolean)
            .join("\n");
    }

    if (item.type === "image") {
        return `[image: ${item.mimeType ?? "unknown MIME"}]`;
    }

    return formatUnknown(item);
}

function summarizeContentItem(item: any): ContentSummary {
    if (!item) return { type: "unknown" };
    if (item.type === "text") {
        const text = String(item.text ?? "");
        return { type: "text", textLength: text.length, lineCount: lineCount(text), preview: preview(text) };
    }
    if (item.type === "resource") {
        const resource = item.resource ?? {};
        const text = typeof resource.text === "string" ? resource.text : "";
        return {
            type: "resource",
            uri: resource.uri,
            name: resource.name,
            title: resource.title,
            mimeType: resource.mimeType,
            textLength: text.length,
            lineCount: lineCount(text),
            preview: text ? preview(text) : undefined,
        };
    }
    return { type: String(item.type ?? "unknown"), preview: preview(formatUnknown(item)) };
}

function summarizeTruncation(truncation: TruncationResult): TruncationSummary | undefined {
    if (!truncation.truncated) return undefined;
    const { content: _content, ...summary } = truncation as TruncationResult & { content: string };
    return summary;
}

function appendTruncationNotice(text: string, truncation: TruncationResult, tool: QmdMcpTool): string {
    if (!truncation.truncated) return text;

    const omittedLines = truncation.totalLines - truncation.outputLines;
    const omittedBytes = truncation.totalBytes - truncation.outputBytes;
    const retrievalHint =
        tool === "query"
            ? `Use ${piToolName("get")} with a result docid/path to retrieve focused source content.`
            : `Use ${piToolName("get")} with fromLine/maxLines, or ${piToolName("multi_get")} with maxLines/maxBytes, to retrieve a smaller range.`;

    return `${text}\n\n[QMD output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
        truncation.outputBytes,
    )} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted. ${retrievalHint}]`;
}

function toPiResult(
    tool: QmdMcpTool,
    args: Record<string, unknown>,
    result: CallToolResult,
    transport: string,
): { content: PiContent[]; details: QmdToolDetails } {
    const contentItems = (result.content ?? []) as any[];
    let output = contentItems.map(contentItemToText).filter(Boolean).join("\n\n---\n\n");
    if (!output) output = formatUnknown(result);

    if ((result as any).isError && !/^QMD reported an error:/i.test(output)) {
        output = `QMD reported an error:\n\n${output}`;
    }

    const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
    });
    const text = appendTruncationNotice(truncation.content, truncation, tool);

    return {
        content: [{ type: "text", text }],
        details: {
            qmdTool: tool,
            args,
            isError: Boolean((result as any).isError),
            transport,
            structuredContent: (result as any).structuredContent,
            contentSummary: contentItems.map(summarizeContentItem),
            truncation: summarizeTruncation(truncation),
        },
    };
}

function getTextOutput(result: { content?: PiContent[] }): string {
    return (result.content ?? [])
        .map((item) => (item.type === "text" ? item.text : `[image: ${item.mimeType}]`))
        .join("\n\n")
        .trim();
}

const SearchSchema = {
    type: "object",
    properties: {
        type: {
            type: "string",
            enum: ["lex", "vec", "hyde"],
            description: "Search type: lex for BM25 keywords, vec for semantic natural language, hyde for a 50-100 word hypothetical ideal-answer passage.",
        },
        query: { type: "string", minLength: 1, description: "Query text for this sub-query." },
    },
    required: ["type", "query"],
    additionalProperties: false,
};

const QueryParams = {
    type: "object",
    properties: {
        searches: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: SearchSchema,
            description: "Typed sub-queries. Put the strongest signal first; QMD gives searches[0] extra weight.",
        },
        collections: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Optional collection names to search (OR). Use this plural field; singular collection is not supported by QMD MCP.",
        },
        intent: { type: "string", description: "Optional disambiguation context. This does not search by itself." },
        limit: { type: "number", minimum: 1, maximum: 100, description: "Maximum results to return (default 10)." },
        minScore: { type: "number", minimum: 0, maximum: 1, description: "Minimum relevance score 0-1." },
        candidateLimit: { type: "number", minimum: 1, maximum: 200, description: "Maximum candidates to rerank (default 40)." },
        rerank: { type: "boolean", description: "Whether to run LLM reranking (default true). Set false for faster RRF-only search." },
    },
    required: ["searches"],
    additionalProperties: false,
};

const GetParams = {
    type: "object",
    properties: {
        file: {
            type: "string",
            minLength: 1,
            description: "File path, qmd:// URI, docid (#abc123), or file:from:count suffix such as #abc123:120:40.",
        },
        fromLine: { type: "number", minimum: 1, description: "Start line (1-indexed). Overrides a :from suffix." },
        maxLines: {
            type: "number",
            minimum: 1,
            description: `Maximum lines to return. Defaults to ${DEFAULT_GET_MAX_LINES} unless PI_QMD_GET_DEFAULT_MAX_LINES overrides it.`,
        },
        lineNumbers: { type: "boolean", description: "Prefix returned lines with line numbers." },
    },
    required: ["file"],
    additionalProperties: false,
};

const MultiGetParams = {
    type: "object",
    properties: {
        pattern: {
            type: "string",
            minLength: 1,
            description: "Glob pattern or comma-separated list of paths/docids, e.g. docs/**/*.md or docs/a.md, #abc123.",
        },
        maxLines: {
            type: "number",
            minimum: 1,
            description: `Maximum lines per file. Defaults to ${DEFAULT_MULTI_GET_MAX_LINES} unless PI_QMD_MULTI_GET_DEFAULT_MAX_LINES overrides it.`,
        },
        maxBytes: {
            type: "number",
            minimum: 1,
            description: `Skip files larger than this many bytes. Defaults to ${DEFAULT_MULTI_GET_MAX_BYTES}.`,
        },
        lineNumbers: { type: "boolean", description: "Prefix returned lines with line numbers." },
    },
    required: ["pattern"],
    additionalProperties: false,
};

const StatusParams = {
    type: "object",
    properties: {},
    additionalProperties: false,
};

async function executeQmdTool(
    bridge: QmdMcpBridge,
    tool: QmdMcpTool,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: { content: PiContent[]; details: Record<string, unknown> }) => void) | undefined,
): Promise<{ content: PiContent[]; details: QmdToolDetails }> {
    const args = withDefaults(tool, params, bridge.config);
    onUpdate?.({
        content: [{ type: "text", text: `Calling QMD ${tool} via ${bridge.describe()}...` }],
        details: { qmdTool: tool, transport: bridge.describe() },
    });

    const result = await bridge.callTool(tool, args, signal);
    return toPiResult(tool, args, result, bridge.describe());
}

function setupText(bridge: QmdMcpBridge): string {
    return [
        "QMD extension is installed. QMD setup and indexing are intentionally manual.",
        "",
        "Install QMD:",
        "  npm install -g @tobilu/qmd",
        "",
        "Create a collection and context:",
        "  qmd collection add ~/path/to/markdown --name myknowledge",
        "  qmd context add qmd://myknowledge \"Describe this knowledge base\"",
        "",
        "Generate embeddings for vec/hyde search:",
        "  qmd embed",
        "",
        "Recommended long-lived MCP server:",
        "  qmd mcp --http --daemon",
        "  export PI_QMD_MCP_URL=http://localhost:8181/mcp",
        "",
        `Current extension transport: ${bridge.describe()}`,
        "",
        "Safety: this extension exposes read-only search/retrieval tools only. It does not run qmd collection add, qmd update, qmd embed, or edit QMD config automatically.",
    ].join("\n");
}

function registerCommands(pi: ExtensionAPI, bridge: QmdMcpBridge) {
    pi.registerCommand("qmd-setup", {
        description: "Show manual QMD setup commands and current qmd extension transport",
        handler: async (_args, ctx) => {
            ctx.ui.notify(setupText(bridge), "info");
        },
    });

    pi.registerCommand("qmd-status", {
        description: "Call QMD status and show index health",
        handler: async (_args, ctx) => {
            try {
                const result = await bridge.callTool("status", {}, ctx.signal);
                const piResult = toPiResult("status", {}, result, bridge.describe());
                ctx.ui.notify(getTextOutput(piResult), piResult.details.isError ? "warning" : "info");
            } catch (error) {
                ctx.ui.notify(`QMD status failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
        },
    });
}

export default async function qmdExtension(pi: ExtensionAPI) {
    const bridge = new QmdMcpBridge();

    registerCommands(pi, bridge);

    pi.registerTool({
        name: piToolName("query"),
        label: "QMD Query",
        description:
            `Search local QMD markdown collections using typed lex/vec/hyde sub-queries. Output is truncated to protect context; retrieve full evidence with ${piToolName("get")}.`,
        promptSnippet: "Search local QMD markdown notes, docs, transcripts, and knowledge bases with typed lex/vec/hyde queries.",
        promptGuidelines: [
            `${piToolName("query")} searches local QMD markdown indexes; use it for notes, documentation, meeting transcripts, and other QMD collections.`,
            `For best recall with ${piToolName("query")}, combine lex keyword queries with vec natural-language queries; use hyde for nuanced questions by writing a 50-100 word ideal-answer passage.`,
            `${piToolName("query")} gives searches[0] extra weight, so put the strongest signal first.`,
            `Scope ${piToolName("query")} with collections: ["name"]; do not use singular collection.`,
            `After ${piToolName("query")} returns docids or paths, use ${piToolName("get")} to retrieve source documents before answering from QMD evidence.`,
            "Do not run qmd collection add, qmd update, or qmd embed automatically; provide manual commands or ask the user if indexing is needed.",
        ],
        parameters: QueryParams,
        executionMode: "parallel",
        prepareArguments: prepareQueryArguments,
        async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
            return executeQmdTool(bridge, "query", params as Record<string, unknown>, signal, onUpdate);
        },
    });

    pi.registerTool({
        name: piToolName("get"),
        label: "QMD Get",
        description:
            "Retrieve one QMD document by file path, qmd:// URI, or docid (#abc123). Defaults to a bounded line count and truncates large output to protect context.",
        promptSnippet: "Retrieve a single QMD document by path or docid, optionally with line range.",
        promptGuidelines: [
            `Use ${piToolName("get")} after ${piToolName("query")} to fetch the source document behind a docid or path.`,
            `Use ${piToolName("get")} fromLine and maxLines for focused retrieval instead of loading very large documents.`,
        ],
        parameters: GetParams,
        executionMode: "parallel",
        prepareArguments: prepareGetArguments,
        async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
            return executeQmdTool(bridge, "get", params as Record<string, unknown>, signal, onUpdate);
        },
    });

    pi.registerTool({
        name: piToolName("multi_get"),
        label: "QMD Multi Get",
        description:
            "Retrieve multiple QMD documents by glob pattern or comma-separated paths/docids. Defaults to bounded per-file lines/bytes and truncates large output.",
        promptSnippet: "Batch retrieve QMD documents by glob or comma-separated paths/docids.",
        promptGuidelines: [
            `Use ${piToolName("multi_get")} when you already know a glob or list of QMD paths/docids.`,
            `Prefer ${piToolName("query")} first when you need relevance ranking, then ${piToolName("get")} for selected evidence.`,
            `Use ${piToolName("multi_get")} maxLines and maxBytes to avoid overwhelming context.`,
        ],
        parameters: MultiGetParams,
        executionMode: "parallel",
        async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
            return executeQmdTool(bridge, "multi_get", params as Record<string, unknown>, signal, onUpdate);
        },
    });

    pi.registerTool({
        name: piToolName("status"),
        label: "QMD Status",
        description: "Check QMD index status, collection health, and embedding availability.",
        promptSnippet: "Check QMD index status, collections, and embedding health.",
        promptGuidelines: [
            `Use ${piToolName("status")} before vec/hyde searches if QMD search fails or embedding status is unclear.`,
            `If ${piToolName("status")} reports missing embeddings, tell the user to run qmd embed manually; do not run it automatically.`,
        ],
        parameters: StatusParams,
        executionMode: "parallel",
        async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
            return executeQmdTool(bridge, "status", params as Record<string, unknown>, signal, onUpdate);
        },
    });

    pi.on("session_shutdown", async () => {
        await bridge.close();
    });
}

# exa `index.ts` 实现说明

## 目标

`index.ts` 将 Exa 的远程 MCP 工具封装成 pi 原生工具：

- `web_search`：搜索网页结果
- `web_fetch`：抓取并读取网页正文

扩展通过 Exa MCP HTTP endpoint 调用远端工具，再把 MCP 返回内容转换为 pi 工具结果。

## 主要依赖

- `@earendil-works/pi-coding-agent`
  - `ExtensionAPI`：扩展注册
  - `ToolDefinition`：SDK 工具类型
- `@modelcontextprotocol/sdk`
  - `Client`：MCP 客户端
  - `StreamableHTTPClientTransport`：HTTP MCP 传输层

## 配置项

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `PI_EXA_MCP_URL` | Exa MCP endpoint | `https://mcp.exa.ai/mcp` |
| `EXA_API_KEY` | Exa API Key，追加到 MCP URL 的 `exaApiKey` 参数 | 无 |
| `PI_EXA_TOOLS` | 请求远端启用的 MCP 工具列表 | `web_search_exa,web_fetch_exa` |
| `PI_EXA_TOOL_PREFIX` | 给 pi 工具名添加前缀，避免冲突 | 空字符串 |
| `PI_EXA_TIMEOUT_MS` | MCP 工具调用超时时间 | `120000` |

## 结构概览

```
index.ts (~270 行)
├── Types (PiContent, ExaTool)
├── Config 常量
├── EXA_TOOLS 工具定义
├── URL helpers (buildMcpUrl, publicUrl, piToolName)
├── toPiContent() — MCP → Pi 内容转换
├── ExaMcpBridge — MCP 连接管理
├── makeExecute() — 共享执行工厂
├── createExaSdkTools() — SDK 导出
└── exaExtension() — 扩展入口
```

## MCP 桥接层

`ExaMcpBridge` 负责管理 MCP 连接与调用：

- `getClient()`：懒加载 MCP client，避免重复连接
- `callTool()`：调用远端 MCP 工具，支持超时和 AbortSignal；连接异常时自动重连重试一次
- `close()`：释放 MCP 连接

## MCP 内容转换

`toPiContent()` 将 MCP `CallToolResult` 转换为 pi 工具结果：

- `text` → `{ type: "text", text }`
- `image` → `{ type: "image", data, mimeType }`
- `resource` → 文本资源直接展开；二进制资源显示 URI/MIME 说明
- `resource_link` → 文本摘要
- 其他类型 → `JSON.stringify()`
- 空 content → 回退为整个 result 的 JSON

## 共享执行工厂

`makeExecute(bridge, tool, onError?)` 返回 `execute` 函数，同时用于扩展注册和 `createExaSdkTools()`：

1. 发送 `onUpdate` 进度消息
2. 调用 `bridge.callTool(tool.mcpName, params, signal)`
3. 转换结果为 Pi content
4. 若 `result.isError`，提取错误消息抛出
5. 异常时回调 `onError`（扩展用它记录 `lastError`）

## SDK 导出

`createExaSdkTools()` 返回 `{ tools, close }`：

- 为每个工具创建 SDK `ToolDefinition`，复用 `makeExecute()`
- 调用方将 `tools` 放入 `AgentSession.customTools`，结束时调用 `close()`

## 扩展入口

`exaExtension(pi)`：

1. 创建 `ExaMcpBridge`
2. 注册 `/exa-status` 命令
3. 遍历 `EXA_TOOLS`，用 `pi.registerTool()` 注册每个工具
4. 在 `session_shutdown` 中关闭 MCP 连接

## 执行链路

```
LLM calls web_search/web_fetch
  ↓
pi tool execute()
  ↓
ExaMcpBridge.callTool()
  ↓
Exa hosted MCP
  ↓
toPiContent()
  ↓
pi tool result + details
```

## 设计要点

- MCP 连接懒加载复用，避免每次调用重新连接。
- 连接失败自动重连重试一次。
- 不再提供自定义 TUI 渲染器；pi 使用默认渲染，完整输出始终对模型可见。
- `createExaSdkTools` 和扩展注册共享 `makeExecute()`，消除重复。

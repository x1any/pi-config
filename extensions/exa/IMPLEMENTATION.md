# exa `index.ts` 实现说明

本文档概述 `extensions/exa/index.ts` 的实现结构与运行流程。

## 目标

`index.ts` 将 Exa 的远程 MCP 工具封装成 pi 原生工具：

- `web_search`：搜索网页结果
- `web_fetch`：抓取并读取网页正文

扩展通过 Exa MCP HTTP endpoint 调用远端工具，再把 MCP 返回内容转换为 pi 工具结果，并为 TUI 提供折叠/展开渲染。

## 主要依赖

- `@earendil-works/pi-coding-agent`
  - `ExtensionAPI` / `ExtensionContext`：扩展注册与执行上下文
  - `Theme` / `ToolRenderResultOptions`：工具渲染类型
  - `keyHint()`：显示当前快捷键提示
- `@modelcontextprotocol/sdk`
  - `Client`：MCP 客户端
  - `StreamableHTTPClientTransport`：HTTP MCP 传输层
- `@earendil-works/pi-tui`
  - `Text`：TUI 文本组件

## 配置项

扩展读取以下环境变量：

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `PI_EXA_MCP_URL` | Exa MCP endpoint | `https://mcp.exa.ai/mcp` |
| `EXA_API_KEY` | Exa API Key，会追加到 MCP URL 的 `exaApiKey` 参数 | 无 |
| `PI_EXA_TOOLS` | 请求远端启用的 MCP 工具列表 | `web_search_exa,web_fetch_exa` |
| `PI_EXA_TOOL_PREFIX` | 给 pi 工具名添加前缀，避免冲突 | 空字符串 |
| `PI_EXA_TIMEOUT_MS` | MCP 工具调用超时时间 | `120000` |

`buildMcpUrl()` 会构建 MCP URL，并在必要时追加 `exaApiKey` 和 `tools` 查询参数。`publicUrl()` 用于状态显示时隐藏 API Key。

## 工具定义

`EXA_TOOLS` 定义两个工具的元信息：

- pi 工具名：`web_search` / `web_fetch`
- MCP 工具名：`web_search_exa` / `web_fetch_exa`
- label、description、promptSnippet、promptGuidelines
- 参数 JSON schema

注册时会通过 `piToolName()` 应用可选前缀。

## MCP 桥接层

`ExaMcpBridge` 负责管理 MCP 连接与调用：

- `getClient()`：懒加载 MCP client，避免重复连接
- `callTool()`：调用远端 MCP 工具
  - 使用 `REQUEST_TIMEOUT_MS`
  - 支持 `AbortSignal`
  - 如果连接异常，会关闭旧 client 后重连并重试一次
- `close()`：在 session 关闭时释放连接

扩展在 `session_shutdown` 事件中调用 `bridge.close()`。

## MCP 内容转换

`toPiContent()` 将 MCP `CallToolResult` 转换为 pi 工具结果内容：

- `text` → `{ type: "text", text }`
- `image` → `{ type: "image", data, mimeType }`
- `resource` → 文本资源直接展开；二进制资源只显示 URI/MIME 说明
- `resource_link` → 转成文本摘要
- 其他未知类型 → `JSON.stringify()`

如果 MCP 没有返回 content，则回退为整个结果的 JSON 文本。

## TUI 折叠渲染

两个工具都提供自定义 `renderCall()` 与 `renderResult()`。

### 公共辅助函数

- `getTextOutput()`：从 pi content 中提取文本输出
- `ellipsize()`：压缩空白并按长度截断
- `expandHint()`：显示展开快捷键提示，优先使用 pi keybinding，异常时回退为 `Ctrl+O to expand`

### `web_search` 渲染

搜索结果解析逻辑：

- `parseSearchResults()` 解析 Exa 文本格式：
  - `Title:`
  - `URL:`
  - `Published:`
  - `Author:`
  - `Highlights:`
- 支持按 `---` 分隔结果；如果没有分隔符，则按多个 `Title:` 拆分
- `usefulHighlight()` 选择一条可用摘要

折叠状态：

- 显示搜索结果数量与查询词
- 默认只显示前 3 条结果
- 每条显示标题、URL、摘要
- 如果还有更多结果，显示剩余数量

展开状态：

- 显示所有结果
- 显示 published/author 元信息
- 每条最多显示 8 条 highlights

如果解析失败，则回退为按行显示原始文本：折叠时最多 12 行，展开时显示全部。

### `web_fetch` 渲染

抓取结果解析逻辑：

- `parseFetchPages()` 解析 Exa fetch 文本格式：
  - `# Title`
  - `URL: ...`
- 每个页面记录：标题、URL、正文行、字符数、行数
- 如果无法识别页面格式，则将全部内容视为一个页面
- `fetchPreviewLines()` 过滤空行、重复标题、分隔符，生成折叠预览

折叠状态：

- 显示抓取页数、总字符数、总行数
- 默认只显示前 3 页
- 每页显示标题、URL、字符数/行数、最多 3 行正文预览
- 如果还有更多页面，显示剩余页面数量

展开状态：

- 显示完整抓取文本

## 命令

`registerStatusCommand()` 注册 `/exa-status`：

- 显示扩展加载状态
- 显示脱敏后的 MCP URL
- 显示注册的工具名
- 显示最近一次错误
- 提示是否设置了 `EXA_API_KEY`

## 扩展入口流程

默认导出 `exaExtension(pi)`：

1. 创建 `ExaMcpBridge`
2. 注册 `/exa-status`
3. 遍历 `EXA_TOOLS`
4. 为每个工具调用 `pi.registerTool()`
5. 工具执行时：
   - 发送 partial update：`Calling exa tool ...`
   - 调用 MCP 工具
   - 转换 MCP content 为 pi content
   - 保留原始 MCP result 到 `details`
   - 设置 `isError`
6. 根据工具类型挂载对应 TUI renderer
7. 在 `session_shutdown` 中关闭 MCP 连接

## 执行链路

```text
LLM calls web_search/web_fetch
  ↓
pi tool execute()
  ↓
ExaMcpBridge.callTool()
  ↓
Exa hosted MCP tool
  ↓
CallToolResult
  ↓
toPiContent()
  ↓
pi tool result + details
  ↓
renderResult() compact/expanded TUI output
```

## 设计要点

- MCP 连接懒加载并复用，避免每次工具调用都重新连接。
- 连接失败时自动重连并重试一次，提高稳定性。
- 工具输出完整保留在 content/details 中，折叠只影响 TUI 展示，不影响模型上下文。
- `web_search` 和 `web_fetch` 的折叠展示分别针对其输出格式做结构化解析。
- 使用 `context.lastComponent` 复用 `Text` 组件，减少 TUI 组件重复创建。

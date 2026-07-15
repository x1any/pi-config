# subagents `index.ts` 实现概要

本文档总结 `extensions/subagents/index.ts` 的主要实现结构、数据流和关键设计。

## 作用

`index.ts` 是 `subagents` 扩展的主入口。它向 pi 注册一个 `subagent` 工具，让主 Agent 可以启动隔离的子 Agent 进程执行独立任务，并把子 Agent 的进度、工具调用、用量和最终输出回传给主进程/TUI。

核心目标：

- 子 Agent 独立上下文，避免污染/消耗主 Agent 上下文。
- 支持同轮多个 `subagent` 工具调用并行执行。
- 支持受控嵌套委派，例如 `worker -> scout/researcher`。
- 在 TUI 中实时显示子 Agent 运行状态和嵌套进度。

## 主要类型

### `AgentConfig`

表示一个子 Agent 定义，来源于 `agents/*.md` 的 frontmatter 和正文。

关键字段：

- `name`：Agent 名称，例如 `scout`、`researcher`、`worker`
- `description`：说明文本
- `tools`：授予该 Agent 的工具列表
- `model`：子 Agent 使用的模型
- `thinking`：思考预算
- `systemPrompt`：Markdown 正文，作为子 Agent 的系统 prompt 追加注入
- `filePath`：Agent 定义文件路径
- `subagentAgents`：如果该 Agent 可继续调用 `subagent`，限制它能派生哪些 Agent

### `AgentProgress`

表示子 Agent 的实时运行状态。

包含：

- `status`：`pending | running | completed | failed`
- `recentTools`：工具调用日志
- `toolCount`：工具调用次数
- `tokens`：当前上下文 token 估算
- `durationMs`：运行耗时
- `lastMessage`：最近的 assistant 文本摘要
- `error`：错误信息

### `AgentResult`

表示一个子 Agent 的完整结果。

包含：

- `output`：最终输出文本
- `exitCode`：子进程退出码
- `progress`：运行进度
- `usage`：token/cost/turns 统计
- `model`、`contextWindow`：模型信息

## 配置加载

配置文件路径：

```text
extensions/subagents/config.json
```

示例见：

```text
extensions/subagents/config.example.json
```

当前支持：

- `maxConcurrency`：同一进程内同时运行的直接子 Agent 数量，默认 `4`，最大 `32`
- `maxStderrBytes`：失败子进程最多保留的 stderr 字节数，默认 `20000`
- `debug`：是否输出调试信息

配置解析失败或字段非法时不会阻止扩展加载，而是打印警告并使用默认值。

## Agent 发现与校验

默认 Agent 目录：

```text
extensions/subagents/agents
```

`loadAgents()` 会读取所有 `.md` 文件：

1. 解析 frontmatter。
2. 读取正文作为 `systemPrompt`。
3. 解析 `tools` 和 `subagent_agents`。
4. 构造 `AgentConfig`。
5. 执行校验。

校验包括：

- Agent 必须有 `name`
- `thinking` 必须是 `low | medium | high | xhigh`
- 工具不能重复
- 工具必须是内置工具或已知自定义工具
- 自定义工具对应扩展文件必须存在
- Agent 名称不能重复
- `subagent_agents` 引用的 Agent 必须存在

此外，扩展暴露了：

```ts
registerAgent(config)
unregisterAgent(name)
```

并挂到：

```ts
globalThis.__subagents
```

用于其他扩展动态注册 Agent。

## 工具与扩展映射

内置工具：

```ts
read, write, edit, bash, grep, find, ls
```

本扩展只显式映射自己实现的工具：

- `subagent` -> 当前扩展自身 `index.ts`

其他扩展提供的工具（如 `web_search` / `web_fetch`）不硬编码到具体扩展文件，由 pi 的正常扩展发现机制提供。

构建子进程参数时，`index.ts` 会：

- 按 Agent 声明的本地工具添加必要 `--extension`
- 使用 `--tools` 限制可用工具
- 如果没有工具则使用 `--no-tools`

## 子进程启动参数

`buildPiArgs()` 负责构建子 Agent 进程参数。

核心行为：

1. 创建临时目录：

```text
os.tmpdir()/pi-sub-*
```

2. 把 Agent 的 `systemPrompt` 写入临时 Markdown 文件。

3. 启动 pi JSON 模式：

```text
pi --mode json -p --no-session --no-skills
```

4. 对本扩展内部工具加载必要扩展：

```text
--extension <local-tool-extension>
```

5. 设置模型和 thinking：

```text
--models <agent.model>
--thinking <agent.thinking>
```

6. 追加子 Agent 系统 prompt：

```text
--append-system-prompt <temp-agent-prompt.md>
```

7. 注入任务：

短任务直接传：

```text
Task: <task>
```

长任务写入临时文件后用 `@file` 引用。

## 嵌套子 Agent 限制

如果某个 Agent 拥有 `subagent` 工具，并且配置了：

```yaml
subagent_agents: scout, researcher
```

父进程会给子进程设置环境变量：

```text
PI_SUBAGENT_ALLOWED=scout,researcher
```

子进程加载本扩展时会读取该变量，只注册 allowlist 中的 Agent。

这用于防止例如 `worker -> worker -> worker` 的无限递归。

当前内置链路通常为：

```text
main agent
  -> worker
      -> scout
      -> researcher
```

## 子 Agent 执行流程

`runSubagent()` 是核心执行函数。

流程：

1. 调用 `buildPiArgs()` 生成命令、参数、临时目录和环境变量。
2. 用 `spawn()` 启动子 `pi` 进程。
3. 监听 stdout，每行按 JSON event 解析。
4. 监听 stderr，按 `maxStderrBytes` 限制保留尾部。
5. 从事件流中更新 `AgentProgress` 和 `AgentResult`。
6. 进程结束后清理临时目录。
7. 根据退出码和错误状态标记 `completed` 或 `failed`。
8. 如果输出过大，使用 pi 的截断工具限制返回内容。

## JSON 事件解析

子进程以 `--mode json` 运行，会输出事件流。`processLine()` 主要处理：

### `tool_execution_start`

- 工具计数加一
- 记录工具名、参数预览、toolCallId
- 标记工具状态为 `running`

### `tool_execution_update`

如果工具是嵌套的 `subagent`，并且 partial result 中带有子结果：

```ts
partialResult.details.results
```

则把它挂到当前工具调用的 `children` 上，用于 TUI 显示嵌套树。

### `tool_execution_end`

- 把对应工具调用标记为 `done`
- 对 `subagent` 工具，刷新最终 children 状态

### `message_end`

当 assistant 消息结束时：

- 累加 token/cost/turns
- 更新当前模型
- 更新 context token 估算
- 提取最终文本输出
- 提取最近几行非代码块文本作为 `lastMessage`

非 JSON 行会被忽略。

## 并发控制

`Semaphore` 限制同一进程内直接子 Agent 的并发数。

特点：

- 默认并发 `4`
- 配置非法时回退默认值
- 最大值限制为 `32`
- 等待并发槽位时支持 `AbortSignal` 取消
- 嵌套子进程有自己的 Semaphore，因此限制只作用于当前进程的直接子节点

注意：这不是全局树级并发限制。

## 取消处理

如果收到 `AbortSignal`：

- 若还在等待并发槽位，会从等待队列移除并抛错
- 若子进程已启动，会先 `SIGTERM`
- 3 秒后仍未退出则尝试 `SIGKILL`

## 输出和错误处理

- `spawn` 启动失败会写入明确错误：

```text
Failed to start subagent process: <message>
```

- 子进程非零退出且 stderr 非空时，stderr 会作为错误信息。
- stderr 超过上限时，保留尾部并插入标记：

```text
[stderr truncated; showing tail]
```

- 子 Agent 最终输出过大时，会根据 pi 的默认限制截断，并追加：

```text
[Output truncated]
```

## TUI 渲染

`renderAgentProgress()` 负责渲染子 Agent 进度。

显示内容包括：

- 状态图标：运行中、完成、失败
- Agent 名称和模型
- 工具调用数量和耗时
- 工具调用日志
- 嵌套子 Agent 树
- 最近 assistant 文本
- token/cost/context 使用情况
- 错误信息

折叠视图会截断长行；展开视图会显示更多内容和最终 Markdown 输出。

## 注册的 `subagent` 工具

扩展默认导出函数中注册工具：

```ts
pi.registerTool({ name: "subagent", ... })
```

工具参数：

- `agent`：要调用的 Agent 名称
- `task`：任务描述
- `cwd`：可选工作目录

工具 prompt 说明强调：

- 子 Agent 没有当前对话上下文
- 任务必须自包含
- 简单单次 I/O 不要用 subagent
- `scout` 用于只读代码侦察
- `researcher` 用于多来源网页研究
- `worker` 用于允许改文件的隔离实现任务
- 独立任务应同轮并行调用

执行时：

1. 校验 `agent` 和 `task`。
2. 找到对应 `AgentConfig`。
3. 查询模型上下文窗口。
4. 构建 live result。
5. 通过 Semaphore 调用 `runSubagent()`。
6. 用 `onUpdate()` 持续向 TUI 返回进度。
7. 返回最终结果；失败时设置 `isError: true`。

## Prompt 注入点

`index.ts` 相关 prompt 注入主要有三处：

1. 主 Agent 看到的 `subagent` 工具描述、参数描述、`promptSnippet` 和 `promptGuidelines`。
2. 子 Agent 的系统 prompt：来自 `agents/*.md` 正文，通过 `--append-system-prompt` 注入。
3. 子 Agent 的用户任务：`Task: <task>` 或长任务文件引用。

## 安全边界

当前实现提供了若干安全限制：

- 子进程使用 `--no-session`，不写入普通会话。
- 子进程工具由 `--tools` allowlist 限制。
- 嵌套 Agent 由 `PI_SUBAGENT_ALLOWED` 限制。
- stderr 和最终输出都有大小限制。

但仍需注意：

- 嵌套并发限制不是全局限制。
- 如果未来允许复杂自定义 Agent 图，建议增加 `maxDepth` 或循环检测。
- 子进程默认仍可能继承父进程环境变量，敏感环境隔离可进一步加强。

## 文件结构关系

```text
extensions/subagents/
  index.ts                    # 主扩展入口，注册 subagent 工具
  config.json                 # 可选运行配置
  config.example.json         # 配置示例
  agents/
    scout.md                  # 只读代码侦察 Agent
    researcher.md             # Web 研究 Agent
    worker.md                 # 可改文件的实现 Agent
```

## 一句话总结

`index.ts` 的核心是：读取 Markdown Agent 定义，按工具权限构建隔离的 `pi --mode json` 子进程，解析子进程事件流为实时进度和最终结果，并通过 `subagent` 工具把这一能力暴露给主 Agent。

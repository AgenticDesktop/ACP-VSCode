# AHP-ACP 转接器（VS Code 扩展）Spec

## Why

VS Code 的 Agent Harnesses 列表目前仅内置 Copilot、Claude、Codex 等少数 harness，而 ACP（Agent Client Protocol）生态中已有大量编码代理（Gemini CLI、opencode、cagent、codex-acp、Qwen Code 等）。需要一个转接器，把任意 ACP Agent 桥接进 VS Code 的统一 Agent 会话体系（长期对齐 AHP/Agent Host 架构与官方 Agent Provider API 提案 microsoft/vscode#325827）。

## What Changes

- 新建 TypeScript VS Code 扩展项目（本仓库为空仓库，无存量代码）
- **Stage 1（本次实施）**：
  - 手动配置 ACP Agents（settings 中的 command/args/env/title/icon/enabled）
  - 通过 proposed API `chatSessionsProvider` 将配置的 agents 注册为 VS Code 原生 Chat Session Provider，显示在 Agent Harnesses（session picker）列表
  - 实现 ACP 客户端运行时：spawn agent 子进程、JSON-RPC 2.0 over stdio、`initialize` 握手与能力协商、进程生命周期管理
  - 会话管理基础功能：新建会话（`session/new`）、历史会话恢复（`session/load`，agent 支持时）、发送 prompt（`session/prompt`）、流式渲染（`session/update`）、取消（`session/cancel`）
  - ACP 权限流：`session/request_permission` → VS Code 审批 UI → 响应
  - 客户端侧文件能力：agent 声明依赖时，由扩展代为实现 `fs/read_text_file` / `fs/write_text_file`（限定工作区）
- **Stage 2 / Stage 3 仅列入路线图，本次不实施**（见文末路线图章节）

## Impact

- Affected specs: 全新能力，无存量 spec
- Affected code: 全新仓库 `d:\ACP-VSCode`（扩展本体 + 测试用 mock agent）
- 运行环境要求：VS Code Insiders + `argv.json` 中 `"enable-proposed-api": ["<publisher>.acp-agent-harness"]`（proposed API 前置条件）
- 协议兼容性：ACP v1（`initialize` 时协商协议版本）；仅支持本地 stdio agents，远程 agents 不在 Stage 1 范围
- 无 **BREAKING** 变更（绿地项目）

## 技术方案摘要（Stage 1）

架构分三层，保持 ACP 协议层与 VS Code API 层解耦（为 Stage 3 迁移至 AHP Agent Host 适配器保留可能）：

```
VS Code Chat UI（harness 选择、会话列表、聊天渲染、审批 UI）
        │  proposed API: chatSessionsProvider（+ chatParticipantAdditions 等）
┌───────┴────────────────────────────────┐
│ 扩展桥接层 provider/                    │
│  · harness 注册/注销（随配置动态变化）    │
│  · ACP session ↔ VS Code ChatSession 映射│
│  · session/update → 聊天响应流渲染        │
│  · request_permission → 审批 UI          │
├────────────────────────────────────────┤
│ ACP 客户端层 acp/                       │
│  · spawn 子进程，JSON-RPC 2.0 over stdio │
│  · initialize 握手 / 能力协商            │
│  · request/response/notification 分发    │
└───────┬────────────────────────────────┘
        │  stdio (JSON-RPC)
   ACP Agent 进程（Gemini CLI / opencode / cagent / codex-acp / mock agent …）
```

设置示例（设置项命名 `acpHarness.agents`，键为 agent id）：

```json
"acpHarness.agents": {
  "gemini": {
    "title": "Gemini CLI",
    "description": "Google Gemini 编码代理",
    "command": "gemini",
    "args": ["--experimental-acp"],
    "env": {},
    "enabled": true
  }
}
```

## ADDED Requirements

### Requirement: R1 手动配置 ACP Agents

系统 SHALL 允许用户通过 VS Code 设置（User/Workspace 级）声明 ACP Agent 条目，每条包含：`command`（必填）、`args`、`env`、`title`、`description`、`icon`（可选）、`enabled`（默认 true）。

#### Scenario: 添加有效配置
- **WHEN** 用户在设置中添加一条含合法 `command` 的 agent 条目且 `enabled` 为 true
- **THEN** 该 agent 出现在 harness 列表中，无需重启窗口

#### Scenario: 禁用条目
- **WHEN** 某条目 `enabled` 为 false 或缺少 `command`
- **THEN** 该条目不注册为 harness；缺少必填字段时在日志中给出可诊断的警告

#### Scenario: 修改配置
- **WHEN** 用户修改/删除任一条目
- **THEN** harness 列表即时反映变更；受影响的运行中连接按 R3 规则处置

### Requirement: R2 Harness 注册与展示

系统 SHALL 使用 proposed API `chatSessionsProvider`（及其配套 proposed API，以锁定的 VS Code Insiders 版本为准）为每个启用的 agent 条目注册一个原生 chat session provider，使其出现在 VS Code 的 Agent Harnesses / session picker 列表中，展示 `title`（默认回退为 agent id）与 `description`，并提供默认图标（`icon` 未配置时）。

#### Scenario: 显示在 harness 列表
- **WHEN** 扩展激活且存在启用条目
- **THEN** session picker 中可见该 agent，选择后可发起新会话

#### Scenario: proposed API 未启用
- **WHEN** 用户的 VS Code 未启用本扩展的 proposed API（如未配置 argv.json 或使用稳定版）
- **THEN** 扩展给出明确的错误提示与修复指引（提示需 Insiders + `enable-proposed-api`），不静默失败

### Requirement: R3 ACP 连接生命周期管理

系统 SHALL 惰性启动 agent 进程：仅在该 agent 的首个会话创建时 spawn 子进程；SHALL 完成 `initialize` 握手与协议版本/能力协商（记录 `agentCapabilities`、`loadSession` 等）；SHALL 在扩展停用或配置变更导致注销时终止相关子进程，不留孤儿进程。

#### Scenario: 惰性启动
- **WHEN** 扩展激活但用户尚未选择某 agent 发起会话
- **THEN** 该 agent 无子进程

#### Scenario: 启动失败
- **WHEN** `command` 不存在、spawn 失败、或 `initialize` 握手失败/超时
- **THEN** 会话创建报错并在 UI 呈现可诊断信息，子进程被清理，可重试

#### Scenario: 进程意外退出
- **WHEN** agent 进程在会话进行中退出
- **THEN** 受影响会话标记中断并提示用户；不出现僵尸状态

#### Scenario: 扩展停用
- **WHEN** 扩展 deactivate 或窗口关闭
- **THEN** 所有由扩展 spawn 的 agent 子进程被终止

### Requirement: R4 会话管理基础功能

系统 SHALL 支持基于 ACP 的会话全流程：`session/new` 创建会话（以当前工作区为 `cwd`）；当 agent 声明 `loadSession` 能力时，SHALL 通过 `session/load` 支持历史会话在会话列表中恢复显示；SHALL 将用户消息经 `session/prompt` 发送，将 `session/update` 通知流式映射为聊天响应（至少覆盖：`user_message`、`agent_message_chunk`、`tool_call`、`tool_call_update`、`plan`、`usage`）；SHALL 支持通过 `session/cancel` 取消进行中的 turn。

#### Scenario: 新建会话并对话
- **WHEN** 用户选择某 ACP agent harness 发起新会话并输入 prompt
- **THEN** 消息发送至 agent，回复内容按 chunk 流式渲染，turn 以 stop reason 结束

#### Scenario: 取消
- **WHEN** turn 进行中用户点击取消
- **THEN** 发送 `session/cancel`，UI 结束当前 turn，后续输入不被拒绝

#### Scenario: 恢复历史会话
- **WHEN** agent 声明 `loadSession` 且用户从会话列表打开历史会话
- **THEN** 通过 `session/load` 恢复上下文，历史消息正确显示，可继续对话

#### Scenario: 不支持恢复
- **WHEN** agent 未声明 `loadSession`
- **THEN** 不提供该 agent 的历史恢复入口，不影响其他功能

### Requirement: R5 权限审批流

系统 SHALL 响应 agent 的 `session/request_permission` 请求，在 VS Code 中呈现审批 UI（展示工具名与选项，选项类型含 allow/allowAlways/deny/reject，逐选项回传更新），并将用户选择回传给 agent。

#### Scenario: 请求审批
- **WHEN** agent 发起 `session/request_permission`
- **THEN** 弹出审批 UI；用户选择后 agent 收到对应 `update`；`reject` 被拒后 agent 收到错误

### Requirement: R6 客户端侧文件能力

当 agent 在 `initialize` 中声明 `fs.readTextFile` / `fs.writeTextFile` 能力（即依赖客户端代为读写文件）时，系统 SHALL 实现 `fs/read_text_file` 与 `fs/write_text_file` 方法，路径处理遵循 ACP 规范（绝对路径、1-based 行号）；SHALL 将可访问范围限制在当前工作区内，工作区外路径返回 JSON-RPC 错误。

#### Scenario: agent 读取工作区文件
- **WHEN** agent 调用 `fs/read_text_file` 读取工作区内文件
- **THEN** 返回文件内容（含换行符格式信息）

#### Scenario: 越界访问
- **WHEN** agent 请求工作区外的路径
- **THEN** 返回 JSON-RPC 错误，不执行 I/O

### Requirement: R7 打包与安装体验

系统 SHALL 以 VSIX 形式打包（vsce/esbuild bundle），并在扩展内提供安装引导：检测 proposed API 未启用时提示用户编辑 argv.json 加入 `"enable-proposed-api": ["<publisher>.acp-agent-harness"]` 并重启（该修复指引亦写入 spec 验收清单，不单独建 README）。

#### Scenario: 本地安装
- **WHEN** 用户在 VS Code Insiders 中安装 VSIX 并完成 argv.json 配置
- **THEN** 扩展激活，R1–R6 功能可用

### Requirement: R8 可测试性

系统 SHALL 附带一个可编程的 mock ACP agent（Node.js 脚本，实现 `initialize`/`session/new`/`session/prompt`/`session/update`/权限请求的最小行为，行为可通过启动参数/环境变量编排），使协议层与桥接层可在无真实 CLI 的情况下自动化测试。

#### Scenario: 自动化回归
- **WHEN** 运行测试套件
- **THEN** 协议层（握手、framing、分发、错误）与 update→渲染映射均有单测覆盖并通过

## MODIFIED Requirements

无（绿地项目）。

## REMOVED Requirements

无。

## 路线图（仅规划，本次不实施）

### Stage 2（近期目标）
- 自动发现已安装的 ACP Agents：扫描 PATH 与已知 agent 清单（Gemini CLI、opencode、cagent、codex-acp、Qwen Code 等），安装即出现、卸载即消失
- Agent 元数据增强：正确图标（内置图标库 + `initialize` 返回的 metadata）、介绍文案
- Agents 的模型管理：基于 `initialize`/`sessionModes` 中的模型信息，支持在 VS Code 中显示与隐藏各 agent 暴露的模型

### Stage 3（远景目标）
- 模型接入：将在 VS Code 中配置的自定义模型（BYOK / Language Model API）提供给支持的 Agents（对齐 `chat.agentHost.byokModels.enabled` 方向）
- 生态联动：识别并接入受支持的 VS Code AI 相关扩展（LM Provider、MCP、tools 贡献）
- 上游化：以本扩展为参考实现，推动官方 Agent Provider/Harness 注册 API（microsoft/vscode#325827）；ACP 层迁移为 AHP Agent Host 的 agent adapter（ACP `session/update` → AHP `chat/delta`/`chat/toolCallStart` 等 agent event mapper），最终纳入 VS Code 源代码

## 参考实现与依据

- 参考实现：`gayanper/vscode-acp-provider`（已归档；同样基于 `chatSessionsProvider` proposed API + `acpClient.agents` 设置模式）
- ACP v1 规范：agentclientprotocol.com/protocol/v1（initialize / session-setup / prompt-turn / tool-calls / file-system）
- AHP 与 ACP 组合模型：microsoft/agent-host-protocol `docs/guide/ahp-and-acp.md`
- VS Code Agent Host / Harnesses 文档：code.visualstudio.com/docs/agents/concepts/agent-host、agent-harnesses
- 官方 API 缺口追踪：microsoft/vscode#325827

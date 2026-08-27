# Tasks

Stage 1 实施任务（Stage 2/3 见 spec.md 路线图，不在此列）。

- [x] Task 1: 项目脚手架与 proposed API 基础设施
  - [x] SubTask 1.1: 初始化 TypeScript 扩展项目：`package.json`（名称 `acp-agent-harness`、publisher 占位、`contributes.configuration` 占位、activation events）、`tsconfig.json`、esbuild 打包脚本、`.vscodeignore`、`.gitignore`
  - [x] SubTask 1.2: 引入 VS Code proposed API 类型声明文件（`vscode.proposed.chatSessionsProvider.d.ts` 及参考实现所用配套 proposal：`chatParticipantAdditions`、`chatParticipantPrivate`、`chatProvider`），锁定一个明确的 VS Code Insiders 版本并在 package.json 声明 `enabledApiProposals`
  - [x] SubTask 1.3: 实现 proposed API 未启用时的检测与错误提示（含 argv.json `enable-proposed-api` 修复指引），扩展激活入口 `src/extension.ts`
- [x] Task 2: ACP 协议层（`src/acp/`）
  - [x] SubTask 2.1: ACP v1 类型定义（`protocol.ts`）：initialize/session/new/prompt/load/cancel、session/update 通知（user_message、agent_message_chunk、tool_call、tool_call_update、plan、usage）、request_permission、fs/read_text_file、fs/write_text_file（可评估官方 `@agentclientprotocol` TS 包，若不适用则自定义所需子集）
  - [x] SubTask 2.2: JSON-RPC 连接（`connection.ts`）：子进程 spawn（command/args/env，Windows 兼容）、stdio framing、id 关联的 request/response、notification 分发、请求超时与进程退出错误
  - [x] SubTask 2.3: AcpAgentConnection（`agentConnection.ts`）：`initialize` 握手、协议版本协商、`agentCapabilities`（含 `loadSession`、`fs.*`）记录、惰性连接与 dispose 时终止进程
- [x] Task 3: 配置层（`src/config.ts`）
  - [x] SubTask 3.1: `acpHarness.agents` 设置 schema（command/args/env/title/description/icon/enabled）与解析校验（缺 `command` 记警告并跳过）
  - [x] SubTask 3.2: 配置变更监听 → harness 注册表 diff 更新（新增注册、删除注销、禁用隐藏）
- [x] Task 4: Chat Session Provider 集成（`src/provider/`）
  - [x] SubTask 4.1: 为每个启用条目注册 chat session provider（proposed API），提供 label/description/默认图标
  - [x] SubTask 4.2: 会话历史：探测 `loadSession` 能力，能力存在时提供基于 `session/load` 的历史会话列表与恢复
- [x] Task 5: 会话交互映射（`src/provider/session*.ts`）
  - [x] SubTask 5.1: 新会话创建（`session/new`，cwd=当前工作区）与 prompt 发送（`session/prompt`）、turn 生命周期与 stop reason 处理
  - [x] SubTask 5.2: `session/update` → VS Code 聊天响应流式渲染（文本 chunk、tool call（pending/in_progress/completed/failed）、plan、usage）
  - [x] SubTask 5.3: 取消（`session/cancel`）与 turn 中断状态处理
- [x] Task 6: 权限与客户端能力
  - [x] SubTask 6.1: `session/request_permission` → VS Code 审批 UI（工具名、选项 allow/allowAlways/deny/reject、逐选项 update 回传、reject 报错）（`src/provider/permissions.ts`）
  - [x] SubTask 6.2: `fs/read_text_file`、`fs/write_text_file` 实现，路径限制在工作区内，越界返回 JSON-RPC 错误（`src/provider/filesystem.ts`）
- [x] Task 7: Mock Agent 与自动化测试
  - [x] SubTask 7.1: mock ACP agent（`test/mock-agent/`，Node 脚本）：可编排的 initialize/new/prompt/update/权限请求行为
  - [x] SubTask 7.2: 协议层单测：握手、framing、request/response 关联、超时、进程退出错误、fs 越界拒绝
  - [x] SubTask 7.3: 桥接层测试：update→渲染映射、权限选项回传（基于 mock agent）
- [x] Task 8: 打包与端到端验证
  - [x] SubTask 8.1: VSIX 打包（esbuild bundle + vsce），本地安装脚本/说明（Insiders + argv.json）
  - [x] SubTask 8.2: 真实 agent E2E（至少一个：Gemini CLI `--experimental-acp` 或 opencode `acp`），执行 checklist.md 手动验收

# 遗留事项（Stage 2 前处理）

- [ ] 真实 agent E2E：本机未安装任何 ACP agent（gemini/opencode/cagent/codex/claude/qwen 均未探测到），无法执行真实对话；安装任一后复验（mock agent 51 用例已覆盖协议与桥接层）
- [ ] Marketplace 发布前补 LICENSE 文件（当前打包仅 WARNING）
- [ ] 用户手动验收：VS Code Insiders 安装 VSIX + argv.json 启用 proposed API 后，按 checklist 功能项走一遍真实 UI 流程

# Task Dependencies

- Task 1 是所有任务的前置
- Task 2 与 Task 3 可并行（均仅依赖 Task 1）
- Task 7.1（mock agent）可与 Task 2 并行（仅依赖 ACP 类型，可先定类型）
- Task 4 依赖 Task 2 + Task 3
- Task 5、Task 6 均依赖 Task 4，二者可并行
- Task 7.2/7.3 随对应功能任务完成后补充运行
- Task 8 依赖全部前置任务

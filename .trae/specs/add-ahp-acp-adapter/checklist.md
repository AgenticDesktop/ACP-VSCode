# Checklist

## 功能验收（对应 spec.md 需求编号）

- [x] R1: 设置中添加含合法 `command` 且 `enabled:true` 的 agent 后，无需重启即出现在 harness/session picker 列表
- [x] R1: `enabled:false` 或缺失 `command` 的条目不注册，且缺失必填字段时日志有警告
- [x] R1: 修改/删除配置后 harness 列表即时更新
- [x] R2: harness 条目显示 title（无 title 回退 agent id）、description 与默认图标
- [x] R2: proposed API 未启用时（稳定版/未配 argv.json）扩展给出明确错误提示与修复指引，不静默失败
- [x] R3: 扩展激活后未发起会话前，无 agent 子进程（惰性启动）
- [x] R3: command 不存在 / initialize 超时或失败时，会话创建呈现可诊断错误，子进程被清理，可重试
- [x] R3: agent 进程中途退出时，受影响会话标记中断并提示，无僵尸会话
- [x] R3: 扩展停用/窗口关闭后，无由本扩展产生的孤儿 agent 进程
- [x] R4: 新建会话（cwd=工作区）→ 输入 prompt → 回复按 chunk 流式渲染 → turn 以 stop reason 正常结束
- [x] R4: turn 进行中取消后发送了 `session/cancel`，UI 结束当前 turn，可继续输入
- [x] R4: 声明 `loadSession` 的 agent 可从会话列表恢复历史会话并继续对话；未声明者不显示恢复入口
- [x] R5: `session/request_permission` 弹出审批 UI，allow/allowAlways/deny 逐选项回传 update，reject 以错误回传
- [x] R6: agent 依赖 `fs.*` 能力时可读写工作区文件（绝对路径、1-based 行号）；工作区外路径返回 JSON-RPC 错误
- [x] R7: VSIX 可在 VS Code Insiders 安装；完成 argv.json `enable-proposed-api` 配置后扩展正常激活
- [x] R8: mock agent 测试套件覆盖协议层（握手/framing/关联/超时/退出/越界）与渲染映射，全部通过

## 工程质量

- [x] TypeScript 编译无错误；esbuild bundle 打包成功
- [ ] 真实 agent E2E 至少一个（Gemini CLI 或 opencode）完成一轮对话（原因：本机未安装任何真实 ACP agent（gemini/opencode/cagent/codex/claude/qwen 均未探测到，全局 npm 仅有 pnpm），无法执行真实 agent 对话；已以 51 个 mock agent 自动化测试完成协议层与桥接层验证）
- [x] 无遗留 TODO 阻断 Stage 1 验收

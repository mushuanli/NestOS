# MindOS 待办交接

更新：2026-10-11。仓库 `/home/li/share/prj/x1`，分支 `v5.3`。已完成事项的详细记录归入提交与活文档，本文只保留接手上下文和未完成工作。

## 待完成的 npm 发布

独立 driver-llm 的修复与 0.2.1 发布准备已推送，但 npm 返回 EOTP，需要账号双重认证。发布包已构建并验证 ESM/CJS 与类型入口。完成发布后将应用所有 driver-llm 依赖统一锁到 0.2.1，删除临时 pnpm 补丁并更新锁文件，重新验证 npm 包消费；主应用不映射本地库源码。当前应用仍使用已发布的 0.2.0 加临时补丁。

## 保留的验收边界

1. 正式浏览器验收：刷新最新版后恢复 demo.md，加入数字分析，检查当前进度、结果编辑、移除后清理与原文保留、再次加入，以及全局忽略/暂停。真实 API 的独立 Kernel 验证不替代正式知识库和 GUI 验收。
2. 远程 harness 来源：分别验证活动会话拒绝、归档读取、只提取可见用户/助手文本、分页和重复游标保护。超过 1 MiB 的历史仍需产品反馈与增量/摘要方案；不得仅移除保护。
3. 长文覆盖率：32,768 个 UTF-16 字符为输入片段上限；优先 turn/消息/文档块边界。每次最多 10 条候选，尚未证明长文事实覆盖率。
4. 恢复与多端：完整进程崩溃、时钟偏差、多宿主接管、多端同步、外部备份恢复及设计中的 S2/S3 验收仍未完成；现有单元测试不能替代这些场景。
5. 无关工作树改动需另行审查：模型费用趋势界面、VFS 配置读取优化、HTTP 审计/冲突/监听参数改动、未跟踪 IndexedDB 独立源码。不要批量 reset/clean，也不要假定修改独立库目录会影响应用。

## 排障与现场

- 本机数据根为 `/home/li/share/prj/pair-x1/mindos`，先核对启动参数/环境变量是否覆盖共享配置；不得将密钥、证书私钥或模型正文写入交接文档。
- HTTPS UI 为 `https://192.168.31.10:2000`，要求客户端证书；证书目录 `/home/li/.config/mindos/http-certs/`。VFS 内部端口 2001 仅监听 loopback。HTTP 审计默认在 `/home/li/.config/mindos/logs/http/audit.jsonl`。
- 模型执行在浏览器 Runtime 中。排查先关联 taskId/requestId：任务事件 → [DigitalTwin] 阶段日志 → 实际 wire 参数与响应块摘要。HTTP 200 不代表正文有效，请求启动也不代表服务端接收确认。
- 本次截断根因是默认思考耗尽输出额度；提取现在显式关闭思考并设置 8192 上限。用量包含缓存输入。JSON 仍严格校验字段与原文 quote，不把思考文本当提取正文。
- 已验证的真实 DeepSeek Kernel 链耗时约 7.4 秒、10 条结果、提交与执行快照清理完成；使用独立内存存储，未写入正式知识库。临时证据 `/tmp/x1-driver-kernel-live-probe.log` 可能被清理。

## 入口与验证

- 领域、预算、授权与扫描：`packages/app-core/src/digital-twin/`。
- 页面、菜单、进度与自动保存：`packages/app-shell/src/digital-twin/`。
- 演示文件与恢复：`packages/app-core/src/presets/initial-files.ts`、`packages/app-settings/src/editors/initial-files.ts`。
- 协议修复在独立 driver-llm 仓库发布；应用固定版本与锁文件见 package.json、pnpm-lock.yaml 和 scripts/npm-libraries.json。
- 规则与支持边界见 [数字分身设计](doc/design/数字分身完整设计与实施计划.md)，npm 消费规范见 [独立库接入](doc/design/npm-library-consumption.md)。

按实际变更运行对应包测试、`pnpm typecheck`、`pnpm architecture:check`、`pnpm styles:check`、`pnpm docs:check` 和应用构建。当前未声称通过全仓完整测试矩阵或正式浏览器端到端验收。

# 作文 Flow CLI 验证

## 2026-10-28：提示词 JSON 与工具输入

通过现有 HTTP 应用端口验证运行版本 `20261028T032921-58ec8d87-dirty`，未重启或部署宿主。将已安装的 `essay-review` 草稿保存并发布为 revision 2：五个模型节点使用 `responseFormat.type=text`，prompt 附完整 JSON Schema，保留 `outputValidation.schema`、`onInvalid=repair` 和 `retries=3`。产品预设同步更新；NestOS 核心机制与模型能力标记均未修改。

- 输入为用户指定的 minds `/essay/require.md`（200 字符）与 `/essay/article.md`（713 字符）。测试 Session 只读挂载该目录，两个 `builtin.tool` 节点调用 `Read@1`；移除工具展示用的标题、分隔线和行号后，与 VFS 原文逐字核对一致，再作为 `requirements`、`essay` 启动评审。没有将正文写入诊断记录。
- 读取 Run：`task_cabe7807-ce82-46f1-9bd8-78fe3f3131f9`，状态 `succeeded`。初次验证图漏配 `capabilities: [Read]` 被正常拒绝为 `Flow tool is not authorized`；补齐显式授权后成功，没有放宽平台授权。
- Session：`node-01M6099K4TN64HVZNGSTF3B6Q8`；评审 Run：`task_15de54a2-d3c9-41fd-8da4-f2614bd1d99a`，状态 `succeeded`，约 18.5 秒。
- 模型 `deepseek-v4-flash`，连接 `default`。设置 `maxRounds=2`、`maxConcurrency=4`、`passScore=9`、`maxExchanges=4`；八次检查和一次改写全部成功，持久任务记录确认均为 text 请求并配置本地 Schema。最终四项均 8.5 分，`completedRounds=2`、`stopReason=max_rounds`。执行成功不等于作文达到 9 分。
- 当前宿主工具目录有 `Read`，未暴露 Bash 或独立 `cat`。本次证明的是确定性读取工具结果可作为 Flow 输入；字面 `cat` 命令未验证。两阶段验证由客户端显式传参串接，不代表作文 Flow 会自动识别路径或执行 Shell。

已有文件的恢复操作仍然保留用户内容，不自动迁移其他用户的作文 Flow；本次仅显式更新上述已安装实例与源码预设。

首次验证通过底层 `dag.run.start`，没有生成聊天 Round，因此当时打开 Session 仍显示初始页。随后在同一 Session 使用正式 CLI `session send --flow essay-review --params ... --follow` 重跑，执行 `task_6d5d5b52-2dda-43da-a2a2-0a6917877a44` 完成，持久历史核对得到 user/assistant 两个投影组，助手状态 success。正式入口与底层执行入口不可混称；未关联分支的既有 Run 通过会话运行面板只读查看，不伪造 Round。

## 结论

2026-09-16 使用本机配置的 DeepSeek 真实接口执行成功。运行的是内置「作文四维评审」的九节点定义；编译后由输入节点、持久路由作用域、报告节点调度，检查节点分别创建独立 Kernel Task。

| 场景 | 参数 | 结果 |
|---|---|---|
| 正常作文 | `passScore=9, maxRounds=2` | 第 2 轮四项均 9 分，`condition_met` |
| 明显不符合要求的作文 | `passScore=9, maxRounds=1` | 得分 1/0/0/0，第 1 轮 `max_rounds` |
| 两项都缺失 | `{}` | 退出码 3，提示补充作文要求和作文内容 |
| 只输入作文要求 | 提供 `requirements` | 退出码 3，只请求作文内容 |
| 独立进程恢复 | 输入节点 + 参数引用报告节点 | 三个 CLI 进程依次 `run → respond → resume`，成功返回补填内容 |

正常作文第一轮创建四个检查 Task，第二轮只创建结构检查 Task。汇总中的内容、语言、逻辑仍指向第一轮结果。读取持久 Task 记录确认五个 Task 的初始消息均只有 `system + user`，没有 assistant 历史或 `sessionContext`，`${param.*}` 已替换为真实输入。

[脱敏运行证据](./fixtures/essay-review-cli-evidence.json)保存 Run ID、Task ID、spawnKey、分数、消息角色及实际用户 prompt。正常作文 Run 为 `20260915160819-b8fef201`，轮数上限 Run 为 `20260915161118-54c3558e`。本机原始记录位于 `/tmp/x1-essay-cli-verification/profile/var/lib/cli-runs/runs/`。

`succeeded` 表示流程执行成功；作文是否达标须看 `stopReason`。模型评分会变化，重复运行不保证得到相同分数。本次未执行完整 10 轮；用 1/2 轮验证可配置边界，模板默认仍为 10 轮。此流程只评审，不自动改写作文。

## 直接运行

在仓库根目录执行；默认读取 desktop profile 的模型连接配置：

```bash
pnpm --filter @itookit/cli build
cp backend/app-core/src/presets/essay-review.json /tmp/nestos-essay-review.flow
node apps/cli/dist/cli.js run \
  -f /tmp/nestos-essay-review.flow \
  --params doc/design/fixtures/essay-review-input.json \
  --headless --json
```

[示例输入](./fixtures/essay-review-input.json)包含作文要求、作文内容、分数阈值、并发数和轮数上限；为限制验证调用量，设置 `maxRounds=2`。改为 10 即按最多十轮执行。无需修改 `.flow` 文件或填写 bindings。

正常作文的首次验证使用临时 `.flow` 副本的参数默认值；轮数上限、缺项输入使用原始 `.flow` 和新增的 `--params`，两种入口均验证通过。

有缺项时保留持久运行并返回退出码 3。使用输出中的 Run ID 和 interaction ID 补填，然后继续：

```bash
node apps/cli/dist/cli.js respond <run-id> <interaction-id> --value '{"essay":"补充的作文内容"}' --json
node apps/cli/dist/cli.js resume <run-id> --json
```

使用自定义 `--profile` 或 `--state-dir` 时，后续命令须传递相同选项。

## 实际验证发现并修复的缺口

1. `RunDefinition → DagRunSpec` 丢失参数定义、模板编译标记和子 Flow 参数作用域，导致 `maxRounds` 解析失败；现在完整传递这些字段。
2. CLI 缺少独立参数文件入口；增加 `--params <file>`，要求 JSON 对象，由 Flow 参数校验器处理类型、默认值和范围。
3. `.flow` 运行恢复错误地按 YAML 解析源快照；现在保存 Flow 运行定义、初始参数和宿主配置，恢复、补填、取消、导出和重跑共享正确入口，继续使用 profile 模型配置。

新增/扩展回归覆盖参数传递、子作用域深拷贝、非对象参数拒绝、缺项补填恢复及 `.flow` 重跑；CLI 类型检查通过。

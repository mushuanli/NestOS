# 用原生 Flow 执行 RAPTOR 规则

全规则对比入口为 [raptor-parity.flow](raptor-parity.flow) 和 [Agent 定义](raptor-parity.agent)：58 个本地规则文件由 `Write` 节点原样写入工作区，Flow 分组调用 Semgrep，再逐条检查独立基线和正负样例预期。规则 ID、相对路径、起止行列、消息、严重级别都参与比较；扫描错误、跳过文件、缺失基线和坏 JSON 单独记录。完整结果落盘，工具输出只返回摘要，避免大结果被终端输出上限截断。

它接收 `cases` 参数，工作区预先提供 `target/` 源码和 `baseline/<case-id>.json` 原版扫描结果。规则、执行、规范化、断言、汇总及最终失败门禁均定义在 `.flow` 中，没有额外业务脚本。用例之间并发执行，一项结果不一致仍会收集其余用例，最后输出 `flow/summary.json`；任一用例失败，根 Task 失败。

```bash
pnpm cli run -f /absolute/path/raptor-parity.flow \
  --params /absolute/path/cases.json \
  --set-home /absolute/path/acceptance/workspace \
  --state-dir /absolute/path/acceptance/state \
  --profile /absolute/path/acceptance/profile --headless --json
```

此确定性 Flow 不需要模型连接。Agent 通过 `execution.kind=flow` 绑定同一发布定义，`execution.parameters.cases` 提供用例清单。下文的 `raptor-review.flow` 则另行验证模型初审、盲审和 Judge 链路；两者的验收范围不同。

## 全样例对比入口

实际验收目录为 `release/raptor-parity/20261023/`，包含原始源码清单及哈希、独立 reference、Flow 输出、失败注入、Agent 持久记录和优化前后运行。上游固定为 `2ac96303d5e382c196aa34b2984a3c6a218132a9`。紧凑结果保存在[全量验收记录](../../../../doc/design/fixtures/raptor-parity-evidence.json)，范围说明见[设计文档](../../../../doc/design/raptor-harness-integration.md)。

| Flow | 实际对比范围 | 执行依赖 |
| --- | --- | --- |
| [raptor-parity.flow](raptor-parity.flow) | 58 个规则文件、166 条本地规则；70 个用例与 reference 逐字段对比，190 条逐用例命中全部一致 | Semgrep、jq；`target/`、`baseline/`、`cases` 参数 |
| [raptor-registry-parity.flow](raptor-registry-parity.flow) | 官方 Python/JS 目标，本地规则加 8 个 registry pack；原 RAPTOR CLI 与 Flow 原始 30 条、去重 16 条一致 | Semgrep、jq、网络；对应 reference 工作区 |
| [raptor-codeql-parity.flow](raptor-codeql-parity.flow) | 五语言、6 个独立数据库；11 条 findings、11 条 codeFlow 路径与原始查询 reference 一致 | CodeQL、五语言 query packs、C/Java/Go 工具链、jq |
| [raptor-sca-parity.flow](raptor-sca-parity.flow) | 官方危险 npm lifecycle 样例、SCA delta 样例，共 2 项 | jq；对应 target/reference |
| [raptor-smt-parity.flow](raptor-smt-parity.flow) | 9 个已提取的 guard 片段，与上游求解器 API 结果一致 | z3、jq；对应 reference |
| [raptor-probe-parity.flow](raptor-probe-parity.flow) | 官方 fuzz C 目标编译后执行 A/B/C 三个固定探针，退出码与结果分类一致 | cc/AddressSanitizer、timeout、sha256sum、jq |

70 项静态用例包括 30 项正例、29 项负例、11 项观察项，覆盖 87 个唯一静态目标文件；190 条包含不同用例的重复扫描，不代表 190 个独立漏洞。全部规则均已加载校验，但上游并未为全部 166 条规则提供正反 fixture。上游规则测试实际运行，最终 98/98 通过且进程 exit 0；该独立测试进程清除继承的代理变量并使用官方支持的 `EIO_BACKEND=posix`，保留上游环境检查。此前代理检查失败和默认异步后端验证失败的记录一并保留，未修改主验收 Flow 的扫描器配置。

registry pack 在本次运行时在线解析，尚未固定远端规则字节。SMT 仅对比 guard 片段，不包含 CodeQL 自动抽取；上游 README 有 2 项与实际求解语义不一致，其中 `validate(ptr)` 仍未经验证。SCA 全部 15 项另有原版 reference 尝试，其中 4 项默认传递依赖解析受本机 netns 限制，改用上游 `--no-resolve-transitive` 后验证直接依赖；原生 Flow 目前只迁移表中的 2 项。固定探针不代表 AFL 自动 fuzz、模型生成 PoC 或 Witness 全链已实现。

各 Flow 都直接编排工具，未调用 RAPTOR CLI 或新增 Python/JavaScript 业务脚本。原 RAPTOR CLI 仅用于独立 reference。修改基线列号、message、severity、JSON 或预期值的负例已验证根任务失败；批处理仍收集后续用例。验收目录及工具链属于本机生成物，Git 不包含大体积数据库。

同一 70 项工作负载还完成了优化前后 Agent 磁盘运行及重开：根 Task 耗时 **813.228 → 320.313 秒（减少 60.61%）**，SQLite **7.87 → 1.63 GB（减少 79.25%）**，418 个 Task 与结果摘要一致。通用修复包括最小赋值快照、分离稳定图与运行状态、缩小聚合状态、避免已消费依赖和已有回执的重复读取；详见[性能记录与兼容边界](../../../../doc/design/raptor-harness-integration.md#全样例对比与性能审查)。新持久检查点须使用新版宿主读取，旧 v1 记录仍兼容。

## 首批模型评审示例

[raptor-review.flow](raptor-review.flow) 内嵌 RAPTOR 原始 Python 六规则，由现有 `Write / Bash / Read` 和 Flow 控制节点执行。它不调用 `raptor.py`、`raptor_agentic.py` 或任何新增 Python/JavaScript 业务脚本。

```text
Write 规则配置 → Semgrep 扫描 → 校验退出码和完整性 → 提取 findings → 分批
  → 每条 finding 的独立函数
      Read 源码 → A–D 初审 + 独立盲审 → Judge
        → 一致时保留 / 有争议时最多修订一次
  → 确定性结构化报告
```

规则来自 RAPTOR [`2ac96303…/engine/semgrep/rules/python/python-security.yaml`](https://github.com/gadievron/raptor/blob/2ac96303d5e382c196aa34b2984a3c6a218132a9/engine/semgrep/rules/python/python-security.yaml)，完整原文在 `rules` 节点的 `Write` 参数中，SHA-256 为 `fdf961cd83fdd21bbc769a5dab540e580229fa2bce10f36427c9811aba3356bc`。版权与许可保留在 [RAPTOR-LICENSE](RAPTOR-LICENSE)。扫描器仍使用这些规则本来的 Semgrep 语法；Flow 负责运行与编排。

## 作为 Agent 执行

在工具箱导入并发布 Flow 后，建立 [示例 Agent](raptor-review.agent) 的执行绑定：`execution.kind=flow`、`flowId=raptor-review`，将 `analysis/consensus/judge` 三个槽绑定到可用的文字模型连接。示例三槽均为 `default`；可分别选择不同模型家族。使用同一模型的独立上下文，只能证明角色和上下文隔离，不能称为跨模型家族共识。

给会话选择已授权的目标项目目录，选择该 Agent 并发送审查要求。每次新请求使用所绑定 Flow 的已发布版本，Run 保存执行快照。原生调用、队列和恢复沿用现有 [Agent Flow 契约](../../../../doc/design/flow-invocation-composition.md)。

运行工作区需要可写入 `raptor-rules.yaml`，以及 `semgrep.stderr.log` 扫描诊断。Flow 中的工具能力分别声明为 `Write / Bash / Read`；模型分析只授予只读工具。写规则及扫描为定义明确声明的确定性操作，仍受宿主工具启用状态和项目授权约束。

## 独立运行 Flow

执行宿主需要已安装 Semgrep，并使 `semgrep` 在实际进程的 PATH 中可见。首次验证建议使用独立的小型测试项目。`bindings.json` 是连接数据文件：

```json
{"analysis":"default","consensus":"default","judge":"default"}
```

```bash
pnpm cli run -f /absolute/path/raptor-review.flow \
  --connection-bindings /absolute/path/bindings.json \
  --set-home /absolute/path/authorized-project \
  --profile /absolute/path/configured-profile --headless --json
```

命令不拼接用户提供的项目路径或规则路径；工作区由宿主授权和执行上下文决定。Flow 参数 `requirements` 与 Agent 用户消息 `${input.prompt}` 一起进入各角色输入和最终报告，均不进入 shell 命令。

## 运行契约与范围

扫描直接运行 `semgrep scan`，显式使用本地规则、严格错误模式和 JSON 输出，不使用 registry 规则源。扫描发现问题时正常退出 0；非零退出、输出截断、非法结果结构或扫描 JSON 的 `errors` 非空都会被端口 schema 拒绝，不会继续模型审查。没有 finding 时返回空评审列表，不调用模型。

每条 finding 通过具名实参进入独立子函数。初审和盲审仅共享该 finding、实际源码及审查要求；Judge 显式接收两份结果。Judge 要求修订、verdict/exploitability 不同、agreement 不是 `agree`，或存在 unresolvedQuestions 时，进入最多一次语义修订。

模型使用 text 传输并在本地按 `outputValidation.schema` 校验 JSON；每个模型节点最多补发 2 次格式修复，仍不合格则失败。这与最多一次语义修订分别计数。最终 JSON 保留原 finding、初审、盲审、判断和最终结论，业务结论与真实机械验证证据分开记录。

首批定义覆盖六条 Python 规则和固定角色审查链。它没有移植 RAPTOR 的全部语言规则、CodeQL、fuzz、二进制分析、动态模型面板、费用预测和自动 patch/exploit。分析提出的可利用性只是带证据与局限的判断，不等同于运行了漏洞验证代码。

标准 Bash 当前的结构化输出仍有 50000 字符上限；本定义通过 `truncated=false` 门禁拒绝不完整结果。它适合首次小项目验收；完整大仓库需要通用完整 JSON/资产输出能力或进一步分批，不能用截断前的 findings 冒充全部扫描结果。CLI native shell 也不构成操作系统隔离；远程项目、沙箱与持久外部 harness 的边界见 [RAPTOR 编排研究](../../../../doc/design/raptor-harness-integration.md)。

## 验证

```bash
pnpm --filter @itookit/cli test tests/raptor-native-flow.test.ts
```

12 项普通回归使用可控扫描器与模型响应，运行真实的 Agent 绑定、发布 Flow、标准文件工具、函数调用、分支与持久 Task；覆盖失败门禁、用户消息、上下文隔离和修复/修订上限。另有 1 项显式 live 验收使用真实 Semgrep 和已有文字连接，默认不发送真实请求。

真实 Agent 链路已验证：6 条原始规则命中 1 条 `raptor.python.insecure-tempfile`，初审、盲审和 Judge 使用独立上下文的 DeepSeek V4 Flash，Judge 触发一次 revise，根 Task 成功。最终定义于 `2026-10-22T17:38:42.251Z` 真实验收成功，9 次模型 HTTP 响应均为 200；发布身份为 `raptor-review@1`。见[机器记录](../../../../doc/design/fixtures/raptor-evidence.json)、[实际报告](../../../../doc/design/fixtures/raptor-report.json)和[设计说明](../../../../doc/design/raptor-harness-integration.md)。同一模型的角色复核不代表跨模型家族共识。

真实输出不保证每次满足 Schema：归档中的一次较早执行在 revise 的 2 次格式修复后仍得到坏 JSON，根 Task 按约定失败，虽然该次 13 个 HTTP 响应均为 200。最终定义收紧回复长度后已真实复验成功。各次尝试独立记录，失败不会返回伪造的成功报告。

验证同时修复了两处通用问题：模型协议按“连接显式值 → 实际模型偏好 → Provider 默认”继承并冻结；Anthropic 同批并行工具结果合入紧随 assistant 的一个 user 消息，保证各 `tool_use` 有对应结果。Flow 保留 Read/Grep，已覆盖真实工具循环。未知协议、后续协议漂移仍拒绝执行，日常用户配置没有被回写。

如需单独重验 live 项，提供已有 profile、Semgrep 程序和证据输出位置：

```bash
RAPTOR_FLOW_LIVE=1 \
RAPTOR_FLOW_PROFILE=/absolute/path/configured-profile \
RAPTOR_FLOW_SEMGREP_BIN=/absolute/path/semgrep \
RAPTOR_FLOW_EVIDENCE=/tmp/raptor-native-evidence.json \
pnpm --filter @itookit/cli exec vitest run tests/raptor-native-flow.test.ts \
  -t 'executes real RAPTOR rules and real model reviews through the published Flow Agent'
```

live 验收通过隔离 profile 使用凭据，不将凭据写入仓库或证据文件。该结果覆盖本地原生 Flow 与 Agent；完整 RAPTOR、Composite 团队、远程执行连接和 Firecracker 后端仍按设计说明分别验收。

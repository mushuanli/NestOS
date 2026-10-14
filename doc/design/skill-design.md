# Skill 系统设计

2026-09-08 按当前源码同步。Skill 是指令、工具绑定、触发/作用域元数据，以及可选 Durable TaskProgram 引用。定义存储、Session 加载状态、工具执行和上下文组装分别管理。本文末尾列出仍需完成的设计接线，不能把接口存在当作产品链路已经实现。

## 1. 类型与持久化

类型定义在 [skill-types.ts](../../backend/tools/src/contracts/skill-types.ts)，服务在 [skill-service.ts](../../backend/tools/src/contracts/skill-service.ts)。`LLMSkill` 是 `SkillDefinition` 的别名（[agent.ts](../../backend/kernel-adapters/src/llm-management/contracts/agent.ts) 第 110 行），启动同步直接传递定义，不再调用 llmSkillToSkillDef 转换。

| 来源 | 存储与读取 | 运行时归属 |
| --- | --- | --- |
| 配置 Skill | 注入 `/etc` 文件来源中的 `/llm/.skills/<id>.yaml`，即系统 `/etc/llm/.skills/<id>.yaml` | LLMDeviceDriver/SkillManager 持久化，共享只读用途的 catalog 定义 |
| 文件系统 Skill | 宿主 SkillSource 扫描 `_agent/skills/<name>/SKILL.md` | 当前 Session 的本地定义覆盖层，不写回共享 catalog |
| 加载状态 | Session capability service 的 loaded/glob 状态；成功 skill.load 的 ID 存入 Session shared state | 每个 Session 独立；恢复按保存 ID 重新加载 |

配置 Skill 的启动加载、reload、保存和删除统一使用 `.yaml`。不加载 `.json/.yml`，保存时不探测或删除旧格式文件；旧文件留在来源中，不参与 catalog。Provider/Connection/MCP 的 JSON 是各自当前格式，不受 Skill 格式约束影响。

`SkillDefinition` 必填字段为 id/name/description/type/enabled/instructions/tools/triggerPatterns/autoLoad/priority。可选字段包括 endpoint/method/headers/parameters、command、MCP 引用、triggerStrategy、source、scopeLevel/scopeRoot、disableModelInvocation、globs、compact、correctionLog、referencePaths、templatePath、fsRoot、supportsSubagent/subagentRole/subagentModel、taskProgram。

SkillType 为 builtin/http/shell/prompt/mcp/custom。类型和参数描述不自动授予执行权：动态工具还需 `SkillToolHandlerFactory` 和 Session ToolService，真正执行走授权 effect。Tauri 受限 Session 当前没有注入原生 shell skill handler。

## 2. Catalog 与 Session 服务

`syncSkillsToKernel` 实现在 [app-core/src/kernel/sync-skills.ts](../../backend/app-core/src/kernel/sync-skills.ts)，由 [app-core/src/runtime/create-application-runtime.ts](../../backend/app-core/src/runtime/create-application-runtime.ts) 在 Kernel 恢复前和 LLMDeviceDriver.onChange 时调用，保存配置 Skill 并删除已移除的 catalog 项。`createKernelAdaptersRuntime()` 提供元数据 catalog；执行工具和技能通过 SessionCapabilityRegistry 按 sessionId 获取。

每个 Session 的 `SkillDeviceDriver` 使用共享 catalog 定义，并拥有独立的文件系统覆盖层、loaded、globMounted、动态工具和 agentInstructions。文件系统同名技能只覆盖本 Session 的查找；刷新、退出和 dispose 不修改其他 Session 或共享 catalog。目录来源返回的定义保存在本地覆盖层，避免 A 的扫描覆盖 B。

服务主要接口：

| 类别 | 方法 |
| --- | --- |
| 定义管理 | listSkills/getSkill/getSkillNames、saveSkill/deleteSkill、onChange |
| 加载 | loadSkill/unloadSkill、getLoadedSkills/getUnloadedSkills |
| 路由 | getRouteLayers、semanticMatchSkills/autoDetectSkills |
| 空间联动 | mountByGlob/unmountByGlob |
| 来源 | registerFromDirectory(dirPath, scopeLevel, scopeRoot)、setCwd、refreshScopedSkills、getScopedSkills |
| 指令辅助 | parseCompactInstructions、getCompactInstructions、getAgentMdContent |

定义枚举是宿主管理接口，可包含当前不可见定义；模型上下文应使用 scoped/route 接口。loadSkill 拒绝不存在、disabled、越出当前目录作用域或已关闭服务的技能。getLoadedSkills/getUnloadedSkills 过滤当前作用域及 enabled 状态。

工具 load_skill 和持久 skill.load effect 都拒绝 disableModelInvocation。宿主显式调用 loadSkill 可用于用户手动触发，仍需满足 enabled 和目录作用域。加载不会自动扩大工具权限；builtin 绑定复用已注册工具，其他绑定须有 factory 才能注册。成功结果附 instructions 和 compactInstructions 的本次加载快照。load_skill 将正文与关键规则作为工具输出交给下一次模型调用，持久 Effect 记录及 Agent messages 保留该返回值；不能只返回“已加载”而遗漏指令。

## 3. 作用域与刷新

| scopeLevel | 可见性 |
| --- | --- |
| 缺省 / vfs / global-fs | 在该服务中始终可见 |
| parent-fs | cwd 等于 scopeRoot，或是其子目录 |
| local-fs | cwd 精确等于 scopeRoot |

这些是 Skill 指令可见性规则，不替代 Session 文件能力或 OS sandbox。SkillSource 是可信宿主端口；不能把任意 Agent 输入直接变成宿主扫描目录。

setCwd 后撤销离开作用域的已加载工具，再刷新来源。刷新首先清空旧文件系统覆盖及 agentInstructions，避免扫描失败期间继续使用旧目录指令。每次扫描有本地 revision；迟到的旧扫描结果被丢弃，不能覆盖新 cwd。dispose 同样使在途扫描失效，并清理本服务注册的工具。

TauriSkillSource 通过注入的 Session ToolVFSContext 读取 `_agent/AGENT.md` 和沿途 `_agent/skills/*/SKILL.md`，不使用 Tauri 原生文件 API。项目根是该作用域创建时的 Session 虚拟 cwd，构建 projectRoot → cwd 的目录链；项目根标 global-fs，中间层标 parent-fs，末级标 local-fs。cwd 在项目根外返回空定义，清理原项目作用域。**多层级规则取舍（2026-09-13 定稿）**：项目规则只取项目根的 `_agent/AGENT.md`，parent-fs/local-fs 层级的 `_agent/AGENT.md` 既不合并也不替换——切换 cwd 不能静默换掉项目指令；Skill 仍按层级级联发现，同名 id 由更深层级覆盖（`loadScope` 按 projectRoot→cwd 顺序返回，消费者按序写入时后者生效）。回归见 `session-file-source.test.ts`。不存在自动向上查找项目根的 findProjectRoot/buildScopeEntries 公共实现。Web/CLI 未配置 SkillSource 时不扫描宿主文件系统。

Tauri 通过 skillSourceForSession 为每个已获取文件视图的 Session 创建独立来源，初始化时 setCwd(files.cwd)。宿主目录到虚拟路径的映射由既有 Session 挂载层处理，Skill 定义及 supporting files 全部使用虚拟路径。挂载变更调用 disposeSession，下一次获取能力时从新视图/cwd 重建来源。添加目录本身不会自动选择项目根，扫描位置取决于已保存的 Session cwd；每次新会话运行组装项目上下文前 refreshScopedSkills，重读项目规则和技能；没有运行中实时 watch。缺失目录/AGENT.md 按空处理，授权或其他 IO 错误终止初始化并释放视图。

同 cwd 刷新保留先前显式加载的文件技能意图：撤销旧定义与工具，扫描后重新校验并读取 supporting files、注册新工具。定义被删除、禁用或禁止模型调用时不重新加载；支持文件读取失败保持未激活，并由宿主在新 Task 提交前报告。显式 unload 会清除意图并使进行中的加载失效；切换 cwd 清除自动重载意图。已返回的指令/Effect/Task 快照不改写。新运行的上下文构建器会消费已加载正文及支持文件；glob 文件关联仍无编辑器自动恢复接线。

## 4. 四层路由

`getRouteLayers()` 按 scoped、enabled 定义分类：

| 层 | 条件 | 预期上下文 |
| --- | --- | --- |
| L1 silent | disableModelInvocation | 不自动注入，不允许模型加载 |
| L2 index | 未加载的普通 Skill | 仅 id/name/description 的可用索引 |
| L3 dynamicMount | 已加载，未关联 glob 文件 | 按需完整指令 |
| L4 spatial | 已加载且有 glob 文件关联 | 与文件生命周期关联的指令 |

语义匹配实际是启发式：先 triggerPatterns 正则（无效表达式跳过），再英文式分词的 description/message 至少两个不同词重叠，再 openFiles glob。它不是 embedding 检索，也不代表稳定的中文语义召回。自动匹配和 glob 挂载跳过 disableModelInvocation。

Glob matcher 支持 `*`、`**`、`?`、`{a,b}`。mountByGlob 记录 skillId 对应文件集合并标记 loaded；关闭最后一个匹配文件时卸载并清理所注册工具。**编辑器 open/close 接线已于 2026-09-11 完成**：`SessionSkillControls` 新增 `mountByGlob(sessionId, filePath)` / `unmountByGlob(sessionId, filePath)`（经 Session 操作队列串行化，只校验非空路径），`SessionWorkbench` 在打开文件编辑器/预览时挂载、在关闭或切换资源时卸载（挂载是**瞬时**的，不写入持久 loaded 身份，重新打开文件即恢复；失败只报告不打断编辑器）。回归：`backend/kernel-adapters/src/skill/session-skill-controls.test.ts`「mounts and unmounts editor targets through the Session scope in order」、`ui/app-shell/tests/session-browser-ui.test.ts`（打开 `/workspace/note.md` 触发挂载、切走后卸载）。

旧文档中的 ContextManager/P0–P4、固定 4000 token 门控和 applyL3LLMSummarize 已不在当前执行链。当前 ContextAssembler 接受 skillsPrompt；FlowNodeBinder 显式解析 capabilityPolicy/节点 skillIds，排除 disabled/disableModelInvocation 定义，将已选技能正文、Compact Instructions 和工具 ID 合并到节点配置。关键规则以独立 system 消息进入 Task input，沿用逐轮裁剪的 system 保护；systemPromptPolicy=none 仍不注入任何系统提示。app-core 装配的 resolveSessionContext（[create-application-runtime.ts](../../backend/app-core/src/runtime/create-application-runtime.ts)）经 [kernel-adapters/src/skill/session-prompt-context.ts](../../backend/kernel-adapters/src/skill/session-prompt-context.ts) 调用 buildSkillPromptContext：刷新来源后将 L2 序列化为仅 id/name/description 的索引，将 L3/L4 已加载定义的正文、支持文件和关键规则合入 session-skill 块；L1 不注入。ContextAssembler 持久保存 project/session-skill/skill-index 系统来源，直接聊天及聊天内 Flow 消费同一快照。该路径的「关键规则」只取 `compact.redLines`（`- [红线] …`）条目（`aggregateCompactInstructions`），非红线的 compact 正文不进入 session-skill 块；直接聊天的 `skillsPrompt` 使用 `compact.rawContent`（含非红线条目）。未加载正文不进入索引，构建失败不提交新 Task，工具白名单不因此扩大。L2 索引默认最多 8192 UTF-8 字节（包含提示头和 JSON），按 priority/id 排序保留完整元数据条目并报告 omitted 数量；过大条目跳过，仍可容纳后续较小条目。buildSkillPromptContext.indexByteLimit 可调整，0 禁用，非法值在读取/加载前拒绝。ContextAssembler 总预算不足时先丢弃 skill-index，再裁剪历史；规则仍受保护。字节上限不是模型 token 精确上限，逐轮 Agent 裁剪仍保留已进入 Task 的 system 消息；新运行将当前用户消息传入匹配器，按 priority/id 顺序加载启用且非静默、非 action 的候选：autoLoad=true 或启发式匹配命中。成功后用 Session shared CAS 合并 loaded ID，持久化失败卸载本次候选并终止提交；此前成功保存的候选仍保留。自动与显式 Effect 加载共用 rememberLoadedSkill。**运行中索引更新与 L4 编辑器事件已接线（2026-09-11 第四十四/五十轮）**：L4 见下方面板段；运行中索引更新指「Skill 目录变化后输入区列表无轮询刷新」——`SessionSkillControls.onChange(sessionId, listener)` 转发该 Session 活动作用域的变更订阅，`llm-ui` 的 `bindSkillRefresh` 绑定后拉取一次并在每次通知时重新拉取，`LLMWorkspaceEditor` 订阅/解绑（回归 `ui/llm-ui/src/shell/skill-refresh.test.ts`、`kernel-adapters` 的 `session-skill-controls.test.ts` 与 `skill-device-driver.test.ts`「notifies a Session change subscription…」，以及 `app-shell` 的 `session-skill-panel.test.ts`「refreshes the visible Skill list…」用真实 `ChatInput` 验证「通知 → 重新拉取 → 面板刷新」整链）。该通知只在宿主进程内传播（`SkillDeviceDriver.notifyChange`），跨进程直改 Skill 文件不触发；已在途 Task 的 system 消息不变，新定义在下一次上下文组装（[prompt-context.ts](../../backend/kernel-adapters/src/skill/prompt-context.ts) 的 `refreshScopedSkills`）才生效；load_skill 的正文已通过持久工具输出进入下一次调用。成功加载的 Effect 还快照该 Skill 已注册且 enabled 的工具定义及 external 分类，Agent 下一轮只合并 allowedToolIds 声明范围内的定义，保留原节点同名定义的优先级。Flow 从节点 capabilities 传递此范围，直接聊天从 capabilityPolicy.toolIds 传递并遵守 WebSearch 开关。未提供 allowedToolIds 的旧 Task 不扩展工具列表。动态外部工具沿用 approval=external 的审批；快照不授予执行权限，真正调用仍经过 Session 工具服务与资源授权。

## 5. 文件格式与已解析字段

```text
_agent/skills/review/
  SKILL.md
  reference.md
  template.md
  examples/
```

```markdown
---
name: review
description: Review API changes
trigger-strategy: reference
auto-load: false
disable-model-invocation: false
globs: ["src/**/*.ts"]
references: ["reference.md"]
template: template.md
priority: 30
task-program:
  kind: skill.review
  version: "1"
---
# Review instructions
Check the changed API.

## Compact Instructions
- [红线] Preserve the authorization boundary.
```

Tauri 解析器读取 name/description、trigger-strategy、auto-load、disable-model-invocation、globs、references、template、priority、subagent.role/model 和合法 task-program。name 规范化为小写 ID；正文提取 Compact Instructions 后存入 instructions。autoLoad 由 trigger-strategy 推导（reference 默认 true、action 恒为 false），显式 `auto-load` 只能在 reference 上把它改为 false；这样文件系统来源也能表达「可被 load_skill/面板/`/sk-<id>` 显式加载并登记持久身份，但新运行不自动注入」的定义，用于区分持久身份恢复与 autoLoad。是否静默仍以 disable-model-invocation 为准，单独设置 action 不自动禁用模型调用。

type 当前固定为 prompt、tools/triggerPatterns 为空。scopeLevel/scopeRoot/fsRoot/source 由来源填充。Tauri 解析器保存 correction-log 的 path、enabled=true 和固定 projectRoot，避免嵌套 Skill 错把局部作用域当项目根；subagent.model 保存为 subagentModel，已接入显式 Flow 委派子模板的模型默认值。reference/template 在显式加载 Skill 时通过 Session 文件能力读取，不能把宿主绝对 fsRoot 自动当作可访问的 Session 虚拟路径。

## 6. 压缩保护、修正日志与委派

compact-extractor 从 `## Compact Instructions` 到下一个二级标题提取 rawContent，解析 `[红线]` 列表，并返回不含该区块的 body。getCompactInstructions 只汇总当前作用域内、已加载、enabled 且允许模型调用的 Skill，避免未选中或静默技能借压缩规则进入上下文。

成功的 load_skill 工具 Effect 由可信 adapter 从当前 Session 已加载、允许模型调用的定义提取 `compact.rawContent`，写入结果的 `skillContext`。Durable Agent 将其保存为按 Skill ID 替换的状态快照，每轮在裁剪后的 messages 前注入关键规则；普通工具返回的同名字段由 adapter 剥除。规则不依赖旧 tool message 继续存在，checkpoint 重放沿用保存内容；同一 Skill 再次加载可以更新快照。此路径不做语义摘要，也不自动将所有 catalog 规则注入。

Flow 与直接聊天初始化选定 Skill 的关键规则已进入 system 消息。直接聊天经 AgentResolver 获取 capabilityPolicy.skillIds 中的配置定义，排除 disabled/disableModelInvocation/action，将正文和关键规则作为 ContextAssembler 的 skill 来源块写入持久 Task input；空选择不读取 catalog，读取失败在提交 Task 前终止。初始化预算保护规则系统块、允许先移除 skill-index；逐轮裁剪保留已进入 Task 的 system 消息，预算是软上限。**初始化工具激活（直接聊天路径已于 2026-09-11 完成）**：`ConversationRunCoordinator` 用与运行时 `load_skill` 相同的快照形状（`{skillId, compactInstructions, tools}`）为 `capabilityPolicy.skillIds` 中**被选中且可用**的 Skill 生成 `input.skillContexts`（`buildLlmTaskInput` 透传，agent program 在 `initialState` 装载）；工具只取「Skill 声明 ∩ 节点能力白名单 ∩ catalog 中存在定义」的交集并按 catalog 标记 external，因此初始化与独立 `skill.load` 走同一条激活/逐轮关键规则重注入路径，且不扩权。**Flow 节点路径已于同轮接线**：`DurableFlowExecutorOptions.resolveSkillContexts(sessionId, skillIds, allowedToolIds)` 在 `taskSpec` 里按节点 `config.skillIds`（字符串去重，非字符串忽略）取快照并写入 `llm.agent` 输入；委派子节点同样经 `taskSpec`，因此其模板 `skillIds` 也生效。聊天内 Flow 由 `ConversationRunCoordinator` 注入 `skillContextResolver`（复用 `resolveSkills` + `resolveTools`，工具仍取「Skill 声明 ∩ 节点能力 ∩ catalog 定义」交集）；没有端口或没有 Skill 目录的宿主得到空数组，不阻断节点提交。回归：`durable-flow-executor.test.ts`「activates a node's initially selected Skills through the host port」（仅声明 Skill 的节点触发端口、非字符串 id 被忽略、节点输入含快照）与 `direct-skill-context.test.ts` 的 resolver 用例。回归：`backend/llm-session/__tests__/direct-skill-context.test.ts` 断言持久 Task input 的 `skillContexts` 只含被选中的可用 Skill 与其白名单内工具（`llm-tasks` 另有初始化激活/关键规则重注入用例）。app-core 装配的 resolveSessionContext 通过 kernel-adapters 的 buildSkillPromptContext 从同一 Session SkillService 的 getAgentMdContent 获取项目规则；ContextAssembler 保存为 project/system 块，直接聊天和聊天内 Flow 的 Task input 均消费该快照。FlowNodeBinder 在重建节点身份消息时保留 project/session-skill/skill-index 块，systemPromptPolicy=none 显式跳过。规则系统块沿用预算及逐轮裁剪保护，没有另建旧 P0.5 路由器；独立 DAG 命令入口也经同一 resolveSessionContext 获取快照，由执行器在 submit 开始时复制该快照，并在每个 Agent 实例创建时注入，覆盖静态、Composite 展开、graph patch 和委派子节点；没有新用户消息时仅使用空消息匹配及 autoLoad 规则。聊天内 Flow 同样从 ContextSnapshot 提取这三个来源交给执行器；已存在的相同系统消息不重复注入，none 不注入，子节点能力仍取自己的声明。独立入口通过宿主 bindNode 调用 bindStandaloneFlowNode，复用 AgentResolver 和现有身份/模型/Skill/委派模板绑定；不创建聊天历史，节点输入或已有 messages 作为任务正文。静态及 Composite 展开节点、预声明委派模板已解析；独立入口与聊天内 Flow 的运行中 graph patch 节点也调用宿主身份绑定器。执行器先验证原始整批 patch，再异步解析全部新增节点、复验并发布；失败时不提交本批新增节点。动态绑定继承产生节点所属 Flow 的默认身份层：编译产物按节点保存默认配置，Composite 展开后保留子 Flow 作用域，执行器冻结并传给 patch/委派后代；保留新增节点原 capabilities、budget 和委派调度策略，工具目录仍只取原 capabilities，避免身份定义扩权；动态节点内委派模板的 resolvedTemplate 已保留解析后的身份消息与模型，并递归限定各级 capabilities/toolIds 为原模板声明，未声明能力时为空。身份解析不能新增 delegation 或旧 subtasks 委派。Skill 版本解析失败在提交前拒绝，不再降级为空 Skill 列表；Agent 身份缺失仍沿用已有回退语义。关键规则已进入某 Task 后的快照保留，不等于授予相应工具后续执行权限，也不等于完整 Skill 版本冻结。

SkillDeviceDriver.loadSkill 在激活前读取声明的 referencePaths、templatePath 和 enabled correctionLog，并把带来源标题的内容附到 SkillLoadResult.instructions。runtime 只注入当前 Session 的 readFile 能力；缺少能力、文件不可读、路径非法或内容超限均明确加载失败。references/template 相对 fsRoot，correctionLog 相对其显式 root（缺省 scopeRoot）；所有根必须是当前 Session 的虚拟绝对路径。禁止绝对引用、协议、反斜杠、控制字符及 ./.. 段，先校验全部路径再读取。最多 20 个文件、单文件 64 KiB、合计 256 KiB（UTF-8），大小检查发生在读取后，不宣称物理 IO 预先限流。

读取期间 cwd/来源 revision 变化或服务关闭会阻止激活，防止迟到内容安装旧工具。load_skill 已将这些内容经工具输出交给下一轮模型，并随 Effect 结果持久保存；它们作为普通指令随历史参与裁剪，只有单独的 Compact Instructions 走关键规则持久保护。没有自动追加修正日志或新的文件授权。Tauri 来源现已使用同一 Session 视图，未挂载的宿主路径仍不可直接读取。

supportsSubagent/subagentRole 仍不自动触发委派，没有 getDelegationHint/buildSubagentSystemPrompt 自动委派链。Flow 子模板显式 skillIds 中 enabled、允许模型调用且 supportsSubagent 的 Skill 可用 subagentModel 提供模型默认值；优先级为子节点显式模型 > 引用 Agent 模型 > 选定 Skill 子模型 > Flow/Session 默认模型。父节点、仅由外层继承的 Skill 不采用这个子模型；多个选定 Skill 的模型冲突且没有更高优先级模型时拒绝编译。现有 Flow 委派组负责执行与权限约束；parent 上下文缺省不继承工具交换时，同时移除工具调用与结果、保留 assistant 正文，避免子任务收到悬空调用。这不是 load_skill 自动创建 TaskGroup。持久多步 Skill 已有 `createSkillTaskSpec(skill, args)`：要求 taskProgram.kind/version，返回默认 deferStart 的 Kernel TaskSpec，输入为 `{ skillId, arguments }`，标签含 skillId。宿主还须注册对应 Program 并授予所需资源。它不会解析任意 Markdown 为可恢复程序。

## 7. UI 与执行入口

SkillSettingsEditor 提供支持文件的路径输入：Session 虚拟 fsRoot、逐行 referencePaths、templatePath，以及 correctionLog 的项目根、路径和独立启用开关。手动保存和表单 YAML 自动保存使用同一解析函数；自动保存保留未显示的工具绑定、触发规则及其他定义字段。输入路径不代表创建挂载或授予权限；当前是文本配置入口，没有文件浏览选择器。

SlashCommandPlugin 为**定义层启用**的 Skill 提供 `/sk-<id>`（按 `definitionEnabled` 过滤，与面板「可否勾选加载」的 `enabled` 区分）。未加载的 action/silent Skill 不能从面板勾选（见下方面板段），`/sk-<id>` 因此是它们唯一的手动词令入口：action/silent 的定义不会被 `load`（模型上下文闸门拒绝），其正文经 `buildActionSkillMessage` 内联进用户消息；可加载的定义则 `load` 后发送 `buildSkillPrompt`。SkillInvocationParser 解析 --key value、Markdown 文件引用、@file、glob 和自由文本；提供 buildActionSkillMessage/buildSkillPrompt 等辅助函数。解析器不是执行器，不能据此声称所有 reference 调用都会走 load_skill 或所有工具类型都已支持。

Skill 上下文组装前，宿主读取 Kernel Session shared 的 kernel-adapters.skills.loaded，并经 sessions.restore 恢复当前来源定义；Effect 路径使用同一恢复入口。**重开语义回归（2026-09-11）**：`session-skill-restore.test.ts` 用真实 runtime + Kernel 验证——首次运行按触发词加载并持久身份后，**新的作用域实例**（等价于重开 Session/换宿主）在用户消息不再匹配时仍按持久身份重新注入正文与关键规则；显式 unload 后同样的新实例不再恢复它，而再次匹配可重新加载（unload 不是永久禁用）。每个活动作用域只恢复一次，并发请求共享恢复过程；销毁/重建阻止旧结果发布。非字符串或空 ID 等损坏记录拒绝，当前禁止模型调用的定义也拒绝；缺失、禁用、越界和支持文件错误继续走 loadSkill 校验。活动作用域内显式 unload 不因每轮读取旧记录而重载，服务层 unloadSkill 仍只修改活动作用域；需要跨重建保留卸载结果时使用 skill.unload Effect。

skill.load effect 验证 skill ResourceHandle grant，按实际 sessionId 解析 service，加载成功后保存 ID。tool.call 经带 skillLoaderArgKey 的工具成功加载后也保存同一记录；失败不登记加载。新 Session service 恢复这些 ID 时再次执行加载检查。Session 加载表保存的是身份；每次 Effect 结果另含本次指令快照。已有工具结果不会因后续 Skill 编辑而改变；重新加载及 Session 重建仍读取当前定义，完整版本固定语义仍需实施和验收。

`skill.unload@1` 要求 skill ResourceHandle execute grant 和 Session shared state，先 CAS 移除目标 loaded ID，再调用当前作用域 unloadSkill。已删除或变为静默的定义仍可清理，因为该 Effect 不先恢复 loaded 列表。持久写入失败不卸载；写入成功后本地清理失败可重试，重复删除不新增 shared revision。作用域重建不再按旧 ID 恢复它。卸载不删除历史 Task/Effect 指令，也不设置永久禁用：之后显式加载或新运行自动匹配仍可重新加载。通用 Agent 工具 `unload_skill` 已注册到 KernelAdapters 工具目录，通过 tool.call 的 tool execute grant 执行；可信工具 metadata 的 skillUnloaderArgKey 指定 ID 参数，Effect 在调用活动作用域卸载处理器前 CAS 删除持久身份，存储失败不卸载。此工具绕过旧加载列表恢复，可清理已经删除的定义；直接调用非 durable 工具服务只卸载活动状态。工具可见性/调用仍受原 Task 工具白名单约束，注册目录不扩大授权。已有 Task 的历史指令和工具定义快照不被改写。聊天输入区的 Skill 面板已接入 SessionSkillControls：显示当前 Session 的持久或活动已加载技能，也保留定义已删除的加载 ID；取消勾选先写 Session shared，再清理当前作用域，成功重新读取列表，失败恢复勾选并显示错误。宿主 UI 控制直接使用 Session shared state，不伪装为 Agent Effect；不新增模型权限，也不删除技能定义。面板同时列出当前作用域已知的可用技能，勾选经 SessionSkillControls.load 加载并持久保存；disabled、disableModelInvocation 和 triggerStrategy=action 的未加载项禁用勾选，已加载项仍可卸载。新加载保存失败会撤销本次活动加载；之前已加载的项不会因此被卸载。同一运行时的 SessionCapabilityRegistry 共享按 Session 的操作队列，UI 的列表/加载/卸载、skill.load/unload Effect、带 Skill loader/unloader metadata 的 tool.call 执行及 reconcile、新运行的自动加载/上下文组装均接入。普通工具只在恢复 Skill 状态时排队，执行本身不占队列；不同 Session 独立。失败释放队列。该队列为当前宿主进程内协调，不是跨进程持久锁；直接调用原始 SkillService 或独立自行装配的 Effect 不自动加入。

## 8. 剩余有效任务与验证

严格版本、自动委派及生命周期故障矩阵的目标行为与验收拆分见 [P2 实施契约](p2-completion.md#2-p2-01-skill-生命周期)。当前 loaded 表支持 format:2（ids/snapshots/drifts），快照包含定义、解析后的正文/支持文件、关键规则及内容摘要。默认 require-reload，可信 Skill 配置可声明 version-policy: keep-old；漂移持久记录旧/新摘要，面板提供显式重新加载。纯 ID 旧记录在执行入口要求 reload，不能伪造旧正文。keep-old 仍复核当前来源、启用状态和工具授权。直接聊天与 Flow 初始 Skill 选择通过 resolveSessionSelectedSkills 使用相同快照。自动委派和完整生命周期故障矩阵仍未完成。

- ~~完成运行中索引更新、L4 编辑器事件~~（均已接线，见 §4）：新运行的 L2 索引与 L3/L4 已加载正文已接入 ContextAssembler。
- 补齐初始化技能的工具激活、独立 skill.load effect；直接聊天与聊天内 Flow 已注入项目规则和所选技能关键规则，load_skill 工具路径已保存并重注入关键规则快照。
- 完成运行中项目文件 watch、L4 文件关联恢复和 Web/CLI 项目来源装配；新会话运行前刷新、Tauri 来源、支持文件读取与挂载变更已使用 Session 文件上下文。继续拒绝未隔离的原生执行。
- 完成 Skill 自动委派到统一 TaskGroup 的编译接线，以及可复核的技能版本恢复语义。

本次修补覆盖 Session 文件系统定义隔离、跨目录加载拒绝、压缩规则过滤、glob 禁用标记、迟到扫描与 dispose，以及 skill.load 禁止模型调用标记。测试在 `kernel-adapters/src/skill/skill-device-driver.test.ts`、`effects/effect-adapters.test.ts`，运行结果见 [核验清单](../deprecated/implementation-audit.md)。原有 skill-task 测试验证 TaskSpec 编译与真实 Kernel 执行。

持久 loaded ID 更新与作用域恢复使用同一严格解析：兼容缺失/null 为空列表，其余值必须为非空白字符串数组。加载和卸载遇到损坏记录均报错，不过滤后覆盖原数据。工具卸载在无 execute grant、被禁用、ID 无效或缺少 Session shared state 时不写记录、不调用本地卸载；持久删除后本地清理失败可重试，不再次写入已删除的 ID。

身份 CAS 仅对 Kernel CONFLICT 重试（最多三次），其他提交前/后存储错误原样报告，避免提交结果不确定被后续读取误报为成功。自动匹配加载复用 rollbackFailedLoad，清理失败以 AggregateError 保留身份写入与卸载两项错误。回归位于 loaded-state.test.ts 与 prompt-context.test.ts；服务层故障注入不等于真实存储事务内 SIGKILL 验收。

批量身份恢复经 restoreLoadedSkills：任一加载失败时逆序卸载本次已成功新增的 Skill，保留恢复前已有选择；清理逐项继续并聚合错误，失败不设置 hydrated 标记，允许来源修正后重试。action 与 disableModelInvocation 定义均拒绝自动恢复。该回滚不修改持久身份；清理自身失败仍明确报告，不能宣称所有工具已撤销。回归位于 restore-loaded-skills.test.ts。

队列包装器在 tool.call 执行/reconcile 查询可信 metadata 前验证 tool execute grant，防止未授权调用先打开 Session 文件/技能作用域。排队的 Skill 变更在开始执行前再次检查 abortSignal，取消后不执行原 Effect；后续操作仍可继续。

Session 作用域销毁会立即使旧 Skill 队列失效；等待项开始时检查所属队列，不能在关闭后重新获取作用域或修改持久记录。关闭过程中拒绝新 Skill 操作，关闭完成后新调用使用新队列。运行时整体销毁永久关闭该 registry 的操作队列。已进入执行的操作不由此机制回滚，继续依赖取消信号、SkillDriver 的作用域/激活版本校验和持久写入边界；此机制不代表已经开始的 I/O 与关闭原子化。


### Tauri 与 CLI 共用文件来源

`kernel-adapters/skill/session-file-source.ts` 的 SessionFileSkillSource 统一处理 `_agent/skills`、项目 AGENT.md、frontmatter 和支持文件路径；仅通过授权 ToolVFSContext 访问，YAML parser 由宿主注入。TauriSkillSource 现在是薄封装；CLI createCliRuntime 也通过 skillSourceForSession 装配该类，工作区 Skill 可以由持久 skill.load Effect 加载并登记身份。

**P0-00 严格恢复语义（2026-09-13）**：`auto-load: false` 的 reference Skill 让两个宿主都能用文件系统定义区分三种现象——新运行命中触发词而加载、重开后按 `kernel-adapters.skills.loaded` 持久身份恢复、以及 unload 后不再复活（再次命中仍可加载，unload 非永久禁用）。回归：`kernel-adapters/src/skill/session-file-source.test.ts`（frontmatter 与多层级取舍）、`session-skill-restore.test.ts`（真实 runtime + Kernel，含「从未加载的 Session 不因 autoLoad 获得 Skill」对照）、CLI `apps/cli/tests/run-skill-context.test.ts`（不匹配的新 Run 不自动注入、命中则加载并落盘身份）。

这统一了发现与加载来源，不表示 CLI 已与桌面端完全统一新运行上下文、自动匹配、加载状态重建或 UI 生命周期；这些装配仍需继续核验。

### 执行与 UI 接线补充（2026-09-14）

buildSkillContexts 从已选择、enabled、允许模型调用且非 action 的定义中构造 skillContexts；工具仅取 Skill 声明、能力白名单与宿主目录交集。buildLlmTaskInput 透传，DurableAgentProgram 保存独立初始状态并沿用运行中加载的规则重注入路径。直接聊天及 Flow 身份绑定同样排除 action 的系统提示注入。已提交 Task 中的正文、关键规则与定义快照不随后续编辑改变；这尚不是严格版本漂移协议。

SessionSkillControls 增加 describe、mountByGlob/unmountByGlob、onChange。enabled 表示模型上下文可加载，definitionEnabled 表示定义可用于手动入口。/skills 打开面板，/skill 加载，/sk-<id> 显式调用；action/silent 的正文作为用户请求发送，已禁用或删除的定义在调用前拒绝。编辑器关闭撤销临时 glob 匹配，不把它当作持久加载身份。

bindSkillRefresh 返回 refresh/dispose；目录通知与菜单刷新合并到同一请求队列，在请求期间有新事件则丢弃旧响应并重读。关闭后的请求和迟到订阅不能重新更新面板。Session/运行时关闭会排空已开始的 Skill 操作及恢复，随后释放文件能力；尚未开始的排队操作拒绝执行。

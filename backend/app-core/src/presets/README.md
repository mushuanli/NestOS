# 初始文件与 Flow 定义库

UI 不附带业务模板。NestOS 产品 Flow 以本目录的 JSON 定义保存，通过 `createNestosFlowLibrary()` 获取副本；后端启动通过 `seedDefaultFlows` 按安装回执准备；前端只在显式操作时调用 `restoreFlowLibrary(commands, templates)`。已有用户版本不会被覆盖。

- `essay-review.flow`：四类独立 Task 评审，默认最多 10 轮、9 分达标；`maxExchanges` 默认 4（至少 2），为初次回答和最多三次结构化输出修复提供预算；运行前填写作文要求与作文内容。
- `anki-generate.flow`：文本与图片共用一个制卡入口，三个内联函数随主定义发布，不安装成独立工作流；支持合并处理和按参数组函数调用。

`anki-generate.json` 是二合一 Anki Flow 的唯一声明源，属于应用产品资源；`tools/anki-cli` 只维护独立业务 Tool 实现，集成验收读取此源，不再保存 Flow 副本。平台核心仍只提供通用 Flow、Tool 和持久执行机制，不按 Anki 名称分支。产品库和系统恢复清单包含 Anki 与新版作文；业务工具通过宿主配置接入。Flow 是内部资源，可以由 Agent 引用并调用；已有用户安装的 Flow、发布版本和手动分组继续保留。

`createNestosFlowDrawers()` 保留默认分组入口，当前返回空数组。宿主可以向 `ToolboxResources` 注入通用分组，用户也可手动分组。分组只改变工具箱逻辑组织，不移动 `.flow` 文件、不改变 Flow ID、已发布版本或调用关系。归档每项的 `drawer` 保存实际分组名，整组导出保留空抽屉；导入按类别重建分组及新资源归属。单独的 `.flow` 文件不携带工具箱组织信息。

运行时草稿、发布版本由 FlowEngine/FlowDefinitionStore 管理；UI 右键运行先填写参数，固定本次版本，再创建并打开独立 Session。

内置模板安装通过 `flow.draft.install` 保存独立安装记录；删除 `.flow` 后记录仍在，重启不再恢复该模板。聊天侧栏将同一 FlowEngine 挂到 `/@flows`，支持展开、打开和右键运行/删除。新增作文文件统一名为 `essay-review.flow`。

主动恢复：设置 → 文件系统（或系统恢复）→ 恢复初始文件。笔记和工作流按组折叠、默认不选，逐项展示名称、目标路径和存在状态，勾选后恢复。清单包含 `readme.md`、`person-agent-demo.md`、`flow文件格式说明.md`、`essay-review.flow` 和 `anki-generate.flow`。聊天侧栏 Flow 目录的恢复操作共用产品 Flow 库。`restoreFlowLibrary` 经 `app.flow-library.restore` 调用 `flow.draft.restore` 和 `flow.revision.create`，显式恢复缺失文件，保留已有修改和安装记录；之后再次删除也不会被普通启动补装。旧用户的 `essay-review.flow` 及其发布版本、历史不会自动删除或改写，源码和恢复清单不再维护旧模板副本。

通用恢复命令接受调用方显式传入的定义数组，按顺序恢复并发布新恢复的定义。单文件可以通过 `functions: FlowDraft[]` 携带内联函数；恢复与发布只安装主资源，内联函数随主版本递归冻结，不进入全局工作流库。跨文件组合仍需先提供被调用的公共 Flow，再提供入口，入口发布时锁定依赖 revision/digest。核心恢复命令本身不自动发布，也不按业务 ID 分支；已有用户定义不会被覆盖。CLI 优先使用内联函数，外部依赖可从入口所在目录加载同名子 `.flow`；运行快照保存展开后的图，恢复无需重新读取最新定义。

工具箱归档保留完整的嵌套 `functions`，递归收集各函数引用的提示词并在导入时重映射提示词身份；局部函数 ID 及其调用引用保持不变，不受同名全局资源导入身份变化影响。

预算说明：`maxRounds` 限制四维评审轮数，`maxExchanges` 限制单个检查或修改 Task 的模型交互次数（包含工具续答和格式修复）。旧模板曾设置 `maxExchanges: 1` 与修复预算冲突；已有用户 Flow 不自动覆盖，迁移时应让检查及修改节点至少允许 2 次交互；当前模板默认 4，可容纳初次回答和最多三次格式修复。保存后从 Flow 目录运行新版本。已有分支保留原发布版本；Session 重新运行读取最新保存的 Flow，并在新分支固定对应发布版本。

作文模板的 `rewrite` 是普通 `builtin.agent` 节点：根据四维意见生成完整修改稿，写回后四项全部重新评审。最多 `maxRounds` 轮；最终输出保留本轮稿件和评分，修改 Task 记录由运行历史保存。当前稿件通过 `${vars.essay}` 读取；`${param.essay}` 保留初始作文。修改节点顶层 `assign.essay = ${output.essay}` 显式写回。已有用户模板需手动迁移这些声明，安装不会覆盖用户修改。

`digital-twin-demo.json` 保存虚构人物林舟的自然语言示例笔记正文；`NestosInitialFiles` 通过宿主当前笔记文件系统创建 `/person-agent-demo.md`，不写宿主固定路径、不自动开启分身扫描。显式恢复只创建缺失文件，已有修改保留；删除后可再次恢复。Flow 仍走 `flow.draft.restore`，保留安装回执。逐文件返回 restored/preserved/failed，部分失败不伪装成全部成功。

图片限制由各外部定义的 `imageConstraints` 声明。图片值复用标准 `image_url` 消息内容块；`messageTemplates` 渲染声明的多模态消息，`messages` 保持已有消息快照。

`notes-readme.json` 是笔记 `readme.md` 的正文源，包含编辑器/AI Chat、HTML Live 可运行示例、nestos-node 接入、权限与功能说明，以及 httpd 可选 swap 配置。与人物样本分开存放；已有文件不自动覆盖，使用恢复初始文件入口按需创建。

`flow-format-guide.json` 是笔记 `flow文件格式说明.md` 的唯一内容源，通过系统恢复 `note:flow-format` 写入 `/home/admin/notes/`，包含供用户与 AI 使用的完整示例与参数说明。恢复保留已有笔记；测试以实际 Flow 校验器验证文档首个完整示例。系统恢复内置 Flow 则覆盖当前草稿并发布新修订，保留历史版本。

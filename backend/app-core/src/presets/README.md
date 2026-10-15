# 初始文件与 Flow 定义库

UI 不附带业务模板。MindOS 模板位于 app-core 的 `src/presets/essay-review-isolated.json`，通过 `createMindosFlowLibrary()` 获取；后端启动通过 `seedDefaultFlows` 按安装回执准备；前端只在显式操作时调用 `restoreFlowLibrary(commands, templates)`。已有用户版本不会被覆盖。

- essay-review-isolated.flow：四类独立 Task 评审，默认最多 10 轮、9 分达标；`maxExchanges` 默认 3（至少 2），为每个检查节点预留一次结构化输出修复；运行前填写作文要求与作文内容。

运行时的草稿、发布版本由 FlowEngine/FlowDefinitionStore 管理；UI 右键运行先填写参数，固定本次版本，再创建并打开独立 Session。

内置模板安装通过 `flow.draft.install` 保存独立安装记录；删除 `.flow` 后记录仍在，重启不再恢复该模板。聊天侧栏将同一 FlowEngine 挂到 `/@flows`，支持展开、打开和右键运行/删除。新增作文文件统一名为 `essay-review-isolated.flow`。

主动恢复：设置 → 文件系统（或系统恢复）→ 恢复初始文件。笔记和工作流按组折叠、默认全选，逐项展示名称、目标路径和存在状态，可取消勾选后恢复。清单包括 `demo.md`、`essay-review-isolated.flow` 和旧版 `essay-review.flow`；旧版用于恢复兼容，不替换新版模板。聊天侧栏 Flow 目录的恢复操作仍只恢复 Flow 定义库。restoreFlowLibrary 经 flow.draft.restore 显式恢复缺失文件，保留已有修改和安装记录；之后再次删除也不会被普通启动补装。

预算说明：`maxRounds` 限制四维评审轮数，`maxExchanges` 限制单个检查 Task 的模型交互次数（包含工具续答和格式修复）。旧模板曾设置 `maxExchanges: 1` 与一次修复冲突；已有用户 Flow 不自动覆盖，需将四个检查节点改为至少 2（建议 3），保存后从 Flow 目录运行新版本。已有分支保留原发布版本；Session 重新运行读取最新保存的 Flow，并在新分支固定对应发布版本。

作文模板包含独立的 `builtin.revise` 修改节点：根据四维意见生成完整修改稿，再重新评审。最多 maxRounds 轮；最终输出保留本轮稿件、评分和修改 Task 记录。

当前稿件通过 `${vars.essay}` 读取；`${param.essay}` 保留初始作文。修改节点顶层 `assign.essay = ${output.essay}` 显式写回。已有用户模板需手动迁移这些声明，安装不会覆盖用户修改。

`digital-twin-demo.json` 保存虚构人物林舟的自然语言示例笔记正文；`MindosInitialFiles` 通过宿主当前笔记文件系统创建 `/demo.md`，不写宿主固定路径、不自动开启分身扫描。显式恢复只创建缺失文件，已有修改保留；删除后可再次恢复。Flow 仍走 `flow.draft.restore`，保留安装回执。逐文件返回 restored/preserved/failed，部分失败不伪装成全部成功。

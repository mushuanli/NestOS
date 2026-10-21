# 初始文件与 Flow 定义库

UI 不附带业务模板。MindOS 模板以本目录的 JSON 定义保存，通过 `createMindosFlowLibrary()` 获取；后端启动通过 `seedDefaultFlows` 按安装回执准备；前端只在显式操作时调用 `restoreFlowLibrary(commands, templates)`。已有用户版本不会被覆盖。

- essay-review-isolated.flow：四类独立 Task 评审，默认最多 10 轮、9 分达标；`maxExchanges` 默认 3（至少 2），为每个检查节点预留一次结构化输出修复；运行前填写作文要求与作文内容。
- anki-build.flow：公共制卡流程，接收 WordData 数组，执行校验、文本补全、可选配图与语音、YAML 清单与 `.apkg` 打包。子流程不声明 runPolicy，由入口限制整次运行。
- anki-generate.flow：文本入口，保留原 ID；接收单词或 WordData JSON，规范化后调用公共流程。
- anki-from-image.flow：图片入口，支持最多 4 张 PNG/JPEG/WebP、合计 6 MiB；视觉识别后必须校对提交，再调用公共流程。额外声明 `vision` 连接，需支持图片输入。

两个入口声明 `text` / `image` / `speech` 连接并显式传给公共流程；配图与语音默认关闭。三个定义均来自外部 anki-cli 工具仓库，需要 Node 宿主安装对应工具模块。

`createMindosFlowDrawers()` 声明默认侧栏分组：`anki-build.flow` 归入“子流程”，文本与图片入口仍在普通流程列表。分组是工具箱的逻辑抽屉，不移动 `.flow` 文件，不改变 Flow ID、已发布版本或调用关系；新安装、系统恢复及已有文件共用相同默认规则，用户显式移动、改名或移除分组优先。工具箱归档的每项 `drawer` 保存当前分组名，整组导出还保存空抽屉，导入时按类别重建分组和新资源归属；单独的 `.flow` 文件不携带工具箱组织信息。

运行时的草稿、发布版本由 FlowEngine/FlowDefinitionStore 管理；UI 右键运行先填写参数，固定本次版本，再创建并打开独立 Session。

内置模板安装通过 `flow.draft.install` 保存独立安装记录；删除 `.flow` 后记录仍在，重启不再恢复该模板。聊天侧栏将同一 FlowEngine 挂到 `/@flows`，支持展开、打开和右键运行/删除。新增作文文件统一名为 `essay-review-isolated.flow`。

主动恢复：设置 → 文件系统（或系统恢复）→ 恢复初始文件。笔记和工作流按组折叠、默认全选，逐项展示名称、目标路径和存在状态，可取消勾选后恢复。清单包括 `demo.md`、`essay-review-isolated.flow`、`anki-build.flow`、`anki-generate.flow`、`anki-from-image.flow` 和旧版 `essay-review.flow`；旧版用于恢复兼容，不替换新版模板。聊天侧栏 Flow 目录的恢复操作仍只恢复 Flow 定义库。restoreFlowLibrary 经 app.flow-library.restore 交由应用层调用 flow.draft.restore 和 flow.revision.create，显式恢复缺失文件，保留已有修改和安装记录；之后再次删除也不会被普通启动补装。

Anki 定义由外部工具仓库的 [anki-generate.flow](../../../../tools/anki-cli/flows/anki-generate.flow) 提供，应用保留 [anki-generate.json](anki-generate.json) 和 [CLI 示例](../../../../apps/cli/examples/anki-generate.flow) 副本用于恢复和运行；测试校验一致性。外部工具安装、原项目迁移和清单契约见 [anki-cli README](../../../../tools/anki-cli/README.md)。Flow 的 `outputs.manifest` / `outputs.package` 声明 YAML 与包的路径及 MIME 类型；文件写入授权工作区的独立操作目录，CLI 返回这些声明输出。Rust 校验输入与生成卡片身份，确定性保留已有非空文本和扩展字段；已有媒体项目直接交给 CLI 的 migrate/pack，Flow 文本输入不导入原媒体。每批最多 20 张卡片。图片识别与校对、恢复后的真实 Rust 打包已通过模拟端点验收；真实 Anki 桌面导入尚未验收。已安装的旧文本版不会自动覆盖，需要删除旧文件后显式恢复，或导入新版定义。

预算说明：`maxRounds` 限制四维评审轮数，`maxExchanges` 限制单个检查 Task 的模型交互次数（包含工具续答和格式修复）。旧模板曾设置 `maxExchanges: 1` 与一次修复冲突；已有用户 Flow 不自动覆盖，需将四个检查节点改为至少 2（建议 3），保存后从 Flow 目录运行新版本。已有分支保留原发布版本；Session 重新运行读取最新保存的 Flow，并在新分支固定对应发布版本。

作文模板包含独立的 `builtin.revise` 修改节点：根据四维意见生成完整修改稿，再重新评审。最多 maxRounds 轮；最终输出保留本轮稿件、评分和修改 Task 记录。

当前稿件通过 `${vars.essay}` 读取；`${param.essay}` 保留初始作文。修改节点顶层 `assign.essay = ${output.essay}` 显式写回。已有用户模板需手动迁移这些声明，安装不会覆盖用户修改。

`digital-twin-demo.json` 保存虚构人物林舟的自然语言示例笔记正文；`MindosInitialFiles` 通过宿主当前笔记文件系统创建 `/demo.md`，不写宿主固定路径、不自动开启分身扫描。显式恢复只创建缺失文件，已有修改保留；删除后可再次恢复。Flow 仍走 `flow.draft.restore`，保留安装回执。逐文件返回 restored/preserved/failed，部分失败不伪装成全部成功。

组合流程恢复时请同时选中三个 Anki 定义；目录清单按公共流程在前排列。应用恢复策略显式发布新恢复定义的可调用版本，核心恢复命令本身不发布，保留已有用户定义；两个入口发布时锁定公共流程 revision/digest。CLI 从入口所在目录加载同名子 `.flow`，运行快照保存展开后的图，恢复无需重新读取最新定义。

图片限制在 Anki 外部定义的 imageConstraints 中声明，不再是核心固定上限。图片值复用标准 image_url 消息内容块；messageTemplates 渲染声明的多模态消息，messages 保持已有消息快照。

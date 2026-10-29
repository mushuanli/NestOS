# 项目会话草稿：边界与扩展

本文对应“项目固定新会话 → 首条消息持久提交 → 正式会话与下一份草稿”的实现。产品行为见 [Session 浏览设计](vfs-session-browser.md#项目内的新会话草稿)。

## 审查与调整

| 原问题 | 调整 |
| --- | --- |
| Session 类型和执行代码直接理解 projectDraft | 通用 SessionSubmission 仅传递提交身份和不透明 source，项目语义留在 app-core |
| 工作台分配 Session ID、生成标题、创建会话并修改编辑器 options | 项目用例负责 prepare；UI adapter 只负责可用性检查与导航，结果显式返回 |
| 存储暴露任意 Partial 更新和可跳过检查的转正入口 | UI 只能使用 ProjectDraftComposer；store 作为内部事务端口，仅供服务与测试使用 |
| 项目服务解析 round 文件布局与历史索引 | llm-session 的 hasCommittedSubmission 封装持久提交证据读取 |
| 草稿继承设置编辑器，保存队列与 DOM 混在一起 | 直接实现 IEditor，独立序列化和 DraftSaveQueue；失败后后续编辑可以重试 |
| 后台恢复订阅没有等待在途任务退出 | runtime adapter 注册/恢复/解绑并 drain，先于存储关闭 |
| 文件入口高亮与资源选择混用 | DirectoryAction 独立契约；动作激活清除旧资源选择，固定引用通过公共过滤函数排除 move/delete |

## 目录与职责

```text
llm-flow/src/contracts/flow.ts
  SessionSubmission                  通用身份与 source，不解释项目策略
llm-session/src/persistence/submission-receipt.ts
  hasCommittedSubmission             检查 Round、execution 引用及提交的历史索引
app-core/src/projects/drafts/
  contracts.ts                       草稿用例、内部事务端口、记录和通知类型
  service.ts                         prepare、恢复、转正与补建策略
  store.ts                           串行写入、CAS、原草稿回执/新草稿原子替换
  record-codec.ts                    数据验证、旧格式迁移、空记录创建
app-core/src/runtime/project-draft-recovery.ts
  attachProjectDraftRecovery         事件接线与关闭时等待在途恢复
app-shell/src/projects/project-draft-editor.ts
  createProjectDraftControls         可用性检查、打开编辑器，不读写草稿记录
ui-common/src/interfaces/SessionDraftControls.ts
  SessionDraftControls               UI 与宿主之间的独立契约
llm-ui-adapter/src/shell/drafts/
  ChatDraftEditor.ts                 共享 ChatView 草稿、同视图转正与宿主接线
  ChatDraftStore.ts                  结构化草稿、附件及图片元数据的兼容持久化
  session-draft-data.ts              UI 配置、附件引用序列化和旧 base64 迁移
  draft-save-queue.ts                旧编辑器兼容保存队列；新输入使用 ChatView.flushDraft
vfs-ui/src/contracts/options.ts
  DirectoryAction                   导航动作声明，不参与文件生命周期
vfs-ui/src/utils/fixed-entry.ts
  mutableEntryIds                   过滤由所属资源管理的固定引用
```

## 对外契约

- 应用调用 `projects.drafts.open(projectId, folder)`，获得 `ProjectDraftComposer`：`initialData/attachments/save/clear/prepare`。调用者拿不到任意 record patch 或直接 promote。
- `prepare()` 持久保存预留身份并幂等创建 Session，返回 `sessionId/submission/resumeOnly`。不会把排队成功等同于正式转正。
- UI 的 `materialize()` 返回 `{ editor, submission, resumeOnly }`，不依赖共享对象被异步修改。UI 使用相同结果完成导航后的首次发送；未知结果只允许打开原会话核对。
- 后续人工发送经 `EditorOptions.resolveSubmission` 请求宿主关联信息；普通会话返回 undefined。
- 会话层只复制 `submission`，用其 `id` 固定 Round 身份并在历史提交后发出 `execution_task_projected`。提交 ID 不是承诺任意写请求都可自动重放的幂等键。
- 项目策略只接受 `source.kind === 'project-draft'`，并再次读取持久证据。事务完成后发布 `project.draftPromoted`，订阅者只更新投影。

## 不变量与兼容

新草稿通过 common 的兼容 UUID 实现在创建时取得唯一身份，显示名称可重复为“新会话”。首次 prepare 沿用该 UUID 作为 Session ID，不因转正或标题修改更换身份。首条消息具备持久提交证据后，原草稿转为正式会话，并在同一事务中补建一个新 UUID 的空草稿；这属于状态提升，重命名只修改标题。此前已处于 submitting 的记录继续使用保存的 sessionId/submissionId 映射，不改写在途提交身份。

当前草稿和转正回执在同一 SeqFile 事务中切换。旧游标不能追随新草稿，迟到保存必须冲突；接收结果不明不得自动再次发送。状态损坏拒绝读取，不静默覆盖为空草稿。旧版无草稿 ID 的记录在事务内迁移；旧 Round 的 projectDraft 仅由证据读取适配器兼容解码。

通知丢失通过启动恢复和打开草稿时的对账修复。跨进程即时通知、上传分块、跨附件内容哈希去重不在本次范围。

### 二进制附件

附件端口仅接受 `ArrayBuffer`，提供 `put/read`，不暴露宿主路径或 DOM File。文件存于 NestOS VFS 的 `/var/lib/projects/<projectId>/draft-attachments/<draftId>/<attachmentId>`；草稿 UI 数据 v2 只保存不透明 ID、原文件名、MIME 和 lastModified。先成功写入字节，再 CAS 保存引用；正文编辑及恢复后编辑复用已有引用，不重复写附件。UI 转换 File，app-core 管理受限路径与生命周期，app-shell 只透传端口。

旧 v1 base64 记录在打开时解码、写入独立文件，再保存 v2；失败保留原记录。清空与持久转正成功后删除原草稿附件目录，发送阶段仍由正式会话附件服务保存自己的副本。转正结果未知时保留草稿附件。迟到上传在写前、写后检查草稿身份，不能向已退休草稿发布引用。加载草稿时重试清理退休目录，以回收提交后崩溃遗留文件。

当前草稿中移除的附件、上传成功但引用保存失败的文件保留至该草稿清空或转正，避免回收仍可能被在途保存引用的数据；不对活动草稿执行猜测性 GC。

## 隔离测试

- app-core：旧数据迁移、坏状态拒绝、CAS、并发恢复仅一个后继、来源错误不转正、仅 Round 文件不转正、关闭 drain。
- llm-session：普通发送不需要项目上下文；通用 submission 在持久 Round 与通知中保持一致。
- app-shell：materialize 返回契约、未知结果不自动重放、转正不抢焦点、新草稿为空、保存失败后可重试。
- vfs-ui：固定入口不进入 move/delete 管线；DirectoryAction 不保留旧资源的活动选择。

# 项目收藏夹

状态：已实施，2026-09-29。

项目卡片固定顺序：**收藏夹 → 文件 → 新会话 → 已有会话**。目录、文件或会话行尾在悬停、键盘聚焦时显示星标，已收藏时保持金色；触屏始终显示。点击切换收藏且不触发条目导航，右键菜单也支持收藏/取消收藏。收藏目录打开后，文件侧栏以该目录为根；收藏文件直接打开内容并保留侧栏的展开状态，不自动展开文件侧栏。会话收藏仍进入会话视图。只读目录可以收藏，收藏不会授予写权限。远程断线仅禁用文件类收藏，已有会话仍可查看；取消收藏不删除目标。

## 分层与接口

- `ProjectFavorites` 保存 `{ id, title, target }`；target 为项目内规范文件路径（含目录类型）或稳定 sessionId。项目身份通过 projectId 分区；不持久化易变的项目文件夹导航地址。
- 数据位于 `<nestos>/var/lib/projects/<projectId>/favorites.seq` 的 items 条目。seq 事务读改写，支持多个视图并发更新；同一目标不重复收藏，每项目最多 256 条。
- `resolveProjectFavorite` 在点击时解析项目当前导航路径，并检查收藏会话仍属于该项目。项目重命名、会话分组移动不需要重写收藏 ID。文件使用路径身份：项目工作区收到已提交的 VFS 删除事件后清理该路径及所有后代收藏，移动/重命名更新后代路径及目标标题，释放视图前等待收藏写入完成。会话收藏在读取/刷新时按当前项目成员和标题校准，删除会话同步清理；同项目分组移动保留 sessionId。未经过 VFS 且未提供变更事件的外部宿主操作不能推测重命名目标。
- `BrowserTarget` 的 favorites/favorite 表示导航投影，不能当作真实文件读写、移动、删除。收藏组为固定条目，收藏项取消通过专门服务完成。
- vfs-ui 的 `favoriteAction` 端口把「查询」与「命令」分开：`state(node)` 只返回 active（`undefined` 表示该行不展示星标），`toggle(node)` 在用户激活后执行；它负责通用菜单、行尾星标展示及点击执行，不依赖项目、HTTP、Session 或配置文件。宿主使用 `projectFavoriteAction` 适配领域操作，图标和文案来自 common，使用 `project.favorites` 和 `vfs.favorites.add/remove`。
- `DirectoryAction.afterChildId(parentPath)` 用资源 ID 指定插入位置，使“新会话”固定在文件后，而非依赖第几个 DOM 节点；未命中时追加到末尾。
- 收藏项与 `quickDelete`、`_readOnly`、`_fixedEntry` 的行级策略统一由 vfs-ui `utils/row-policy.ts` 判定：收藏读写宿主元数据而非资源，只读行同样可以收藏。

收藏只是持久快捷入口，不是副本、挂载或权限配置。当前不增加自动同步和跨项目收藏。

## 模块边界

`backend/app-core/src/projects/favorites/` 按职责组织：

- `contracts.ts`：目标模型、原子存储端口和文件变更端口。
- `policy.ts`：删除后代、路径迁移、去重和会话校准的纯函数；无 I/O。
- `codec.ts`：持久记录和目标路径校验。
- `store.ts`：`SeqProjectFavoriteStore` 实现原子 `read/update`；更新后先校验再提交。
- `service.ts`：`ProjectFavorites` 编排策略、缓存和通知；同项目读写串行，防止旧读取覆盖最新收藏状态。
- `lifecycle.ts`：将 VFS 提交事件适配为文件变更端口，释放时等待更新完成。
- `routes.ts`：将收藏身份解析为当前资源路径和类型，不决定侧栏展示。

宿主 `project-favorites.ts` 只把 UI 动作转成服务调用，统一由服务通知触发刷新，避免菜单回调和订阅重复刷新。`ProjectNavigation.sync(path, options)` 使用具名的 reveal/project/draft/fileView 选项；收藏的持久模型不包含侧栏状态。vfs-ui 保持通用 state/toggle 端口，不依赖项目存储。

路由解析统一在 `app-core/src/session/browser-routes.ts`，收藏解析不加载整个浏览后端；项目列表展示策略在 `app-shell/src/projects/navigation-policy.ts`。收藏服务先发布新缓存再通知订阅者，通知中的同步查询能看到已提交状态。工作台对异步收藏解析记录导航代次，过期结果不再打开目标或改变选择。

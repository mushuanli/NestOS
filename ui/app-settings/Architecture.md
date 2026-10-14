## Architecture

```
src/
├── index.ts               ← createSettingsModule() + 导出
├── engine/
│   ├── SettingsEngine.ts   ← IFileSystem 实现 (SETTINGS_PAGES → 只读虚拟节点)
│   └── SkillsEngine.ts     ← IFileSystem 实现 (LLMSkill → 可写虚拟节点)
├── editors/                ← 设置编辑器 (继承 BaseSettingsEditor)
│   ├── AboutSettingsEditor.ts
│   ├── AppearanceSettingsEditor.ts  ← 浅色/深色/跟随系统, 写入 /ui/theme.json
│   ├── ContactSettingsEditor.ts
│   ├── LogSettingsEditor.ts         ← 日志级别 + 查看器 (log/ 子模块)
│   ├── RecoverySettingsEditor.ts    ← 数据恢复
│   ├── StorageSettingsEditor.ts     ← 存储概览/迁移/快照/同步/危险区 (storage/ 子模块)
│   ├── TagSettingsEditor.ts         ← 全局标签管理
│   ├── SystemFSExploreEditor.ts     ← 跨模块只读 VFS 浏览 (system-fs/ 组装视图)
│   ├── log/                         ← LogLevelConfigSection / LogOverviewSection / LogViewerSection
│   ├── storage/                     ← StorageOverview / Migration / Snapshot / DangerZone Section
│   └── system-fs/                   ← system-file-inspector.ts
├── factories/
│   └── settingsFactory.ts  ← createSettingsFactory()
├── types/
│   ├── types.ts            ← SettingsState, Contact, Tag...
└── styles/
```

## 核心组件

### createSettingsModule()

```typescript
const settings = localBackend.settings(vfs, workspaces);
const { service, engine } = await createSettingsModule(settings);
// settings/service: SettingsPort supplied by the host
// engine: SettingsEngine (IFileSystem)
```

### SettingsEngine

把 `SETTINGS_PAGES` 的每个分类映射为一个只读虚拟文件节点（`IFileSystem` 实现，`viewId: 'settings_ui'`，`path` = 分类 slug），使设置页面可以通过 `VFSUIShell` 展示；写操作被拒绝（`createFile`/`rename`/`move`/`delete` 抛错，`writeContent` 仅告警）。

### SkillsEngine

把 `IAgentManagementService.getSkills()` 返回的技能列表映射为可写虚拟文件节点（`IFileSystem` 实现，`viewId: 'skills'`，`path` = `/{skillId}`），技能节点规则：
- `node.name` = Skill 名称
- `node.tags` = `['disabled']` (禁用时)
- `node.metadata.hasUnreadUpdate` = `enabled` (绿点)
- `node.metadata.skillType` = Skill 类型
- `readContent()` 返回 Skill id；`writeContent()` 接收 YAML 并 `saveSkill()`

### Settings 编辑器一览

| 编辑器 | 功能 |
|---|---|
| `StorageSettingsEditor` | VFS 容量使用、数据迁移、快照管理、同步设置、危险操作 |
| `LogSettingsEditor` | 日志级别配置、概览统计、日志查看器 |
| `RecoverySettingsEditor` | 从备份/快照恢复数据 |
| `TagSettingsEditor` | 全局标签颜色/名称管理 |
| `ContactSettingsEditor` | 联系人管理 |
| `AppearanceSettingsEditor` | 主题切换 (写入 `/ui/theme.json`) |
| `SystemFSExploreEditor` | 跨模块只读 VFS 浏览 (含 `/dev` 与 `/workspaces/<name>`，调试用) |
| `AboutSettingsEditor` | 版本信息 |

LLM 设置编辑器（Provider / Connection / MCP / Cost / SystemPrompt）来自 `@itookit/llm-settings-ui`，经 `LLMUIEditors` 接口注入。

### createSettingsFactory()

```typescript
const factory = createSettingsFactory(
    settingsService: SettingsPort,
    agentService: IAgentManagementService,
    connectionService: IConnectionService,
    llmUiEditors: LLMUIEditors,
): EditorFactory;
```

## Conventions

- SettingsService、LabelStore 与导入导出用例位于 app-core/settings；SnapshotService 位于 Web 存储宿主。设置 UI 通过 SettingsPort 使用能力。
- 后端设置数据持久化在 VFS `/etc` 视图（`SettingsService.init()` 中 `vfs.openFileSystem('/etc')`）：标签 `/tags.seq`、联系人 `/contacts.json`
- 编辑器继承 `BaseSettingsEditor`（`@itookit/ui-common`），实现 `IEditor`
- `StorageSettingsEditor` 的子 section 各自独立：`StorageOverviewSection`, `MigrationSection`, `SnapshotSection`, `DangerZoneSection`
- `AppearanceSettingsEditor` 写 `/ui/theme.json`，通过 `app:theme-change` 事件广播
- `SystemFSExploreEditor` 经 `createSystemFileInspector()` 组装只读视图：`/dev` 挂载设备描述，`/workspaces/<name>` 挂载各工作区文件系统

pi-agent 连接位于工具箱 MCP，Storage 不再注入远程连接编辑器。MCP 表单通过中立 ConfigurationFormControls 扩展，业务授权与控制中心由 app-shell/app-core 装配。

目录与模块边界见 [前后端模块边界](../../doc/design/frontend-backend-modules.md)。设置 UI 不直接调用 IndexedDB 或 navigator.storage，也不装配执行 Runtime。

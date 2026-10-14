# @itookit/kernel-adapters

Kernel 外部能力公共包。提供 LLM、Tool、Skill load、Bash、TTY 的抽象端口、平台无关公共实现和 Durable Effect 适配器。

`@itookit/durable-kernel` 只负责调度、状态和资源管理；本包通过 `KernelPlugin` 注册外部能力。

## 目录

```text
src/
  effects/  Durable Effect adapters
  plugin/   KernelAdaptersPlugin
  ports/    application-injected capability contracts
  programs/ Durable Interaction programs
  runtime/  session-scoped capability assembly
  llm/      platform-neutral LLM device adapter
  llm-management/ VFS model device, configuration, MCP and Skill management
  skill/    platform-neutral Skill registry and routing
  tool/     runtime-bound tools
  tty/      interactive shell tools
```

根入口的 Effect 与执行能力通过 `KernelAdaptersRuntimeOptions` 注入，不直接操作原生进程或 Tauri API。模型管理子入口提供 HTTP 配置测试和 MCP 网络接入；MCP stdio 按 browser/default 条件选择宿主桥或 Node SDK transport。

## 模型管理子入口

`/llm/core` 提供 LLMDeviceDriver 与设备常量；`/contracts` 拥有公共管理接口，`/llm/config` 提供配置编码，`/llm/presets` 提供可选 MindOS 目录，`/llm/mcp-host` 提供实例传输桥。旧 `/llm` 聚合已删除。

```ts
import { LLMDeviceDriver } from '@itookit/kernel-adapters/llm/core';

const driver = new LLMDeviceDriver(vfs, { llmLogger, presets: hostPresets });
await driver.init();
// Existing device and management APIs are available after initialization.
await driver.dispose();
```

`/llm/core` 默认使用空目录，不加载内置 Provider、连接、Agent 或价格，也不自动创建连接。`presets` 接受 `Partial<LlmManagementPresets>`，构造时深拷贝隔离；持久配置和用户修改按原有规则保留。宿主通过 `providerConnectionPolicy` 决定启用 Provider 后是否自动创建连接；不传时不创建。预设连接的更新由宿主递增 `version` 控制。

需要 MindOS 默认行为时，从 `/llm/presets` 导入 `createMindosLlmPresets`、`firstChatModelConnection`，显式传入这两个选项。旧 `/llm` 入口继续自动选择这套预设和策略，仅作兼容。契约入口 `/contracts` 不加载 VFS、YAML、MCP 或产品目录。

只需要模型通信时使用独立的 `@itookit/driver-llm`；它没有运行时依赖，不需要本包。模型集成详情见 [管理接口](./doc/llm-management/README.md)。

## 使用

```ts
const kernelAdapters = await createKernelAdaptersRuntime({ llmDriver, ttyDriver });
const kernel = new Kernel({ catalog });
await kernel.use(kernelAdapters.plugin);
```

插件按可用服务注册 `llm.chat`、`tool.call`、`process.exec`、`tty.command`、`skill.load`、`skill.unload`，并注册 `kernel-adapters.approved-effect` Durable Program。能力状态按 Kernel Session 隔离；Skill 加载集合写入 Session shared state；TTY 操作必须持有对应 `ResourceHandle(execute)`。无法确认外部副作用的 Bash/TTY 恢复会进入 `indeterminate`，不会盲目重复执行。

## Skill 执行边界

Skill 是 manifest、指令、assets、工具和可选 TaskProgram 的能力包，不统一压缩成
Effect。加载或单次外部调用使用 Effect；多步、有状态、需要等待或审批的 Skill 在
manifest 中声明 `taskProgram`，并编译成 Durable Task：

```ts
const spec = createSkillTaskSpec(skill, { path: 'src/index.ts' });
const task = await session.submit(spec);
const workspace = await task.createResource({
  kind: 'workspace', uri: 'workspace://skill', rights: ['read', 'write'],
});
await task.signal({
  type: 'capabilities', payload: { workspaceHandleId: workspace.handle.id },
});
await task.start();
```

`createSkillTaskSpec` 默认设置 `deferStart=true`，便于在调度前绑定 ResourceHandle。
TaskProgram 由 Skill 插件注册；KernelAdapters 不执行或解释 Skill 私有状态机。

`skill.unload@1` 使用与加载相同的 `{ resourceHandleId, skillId }` 请求，要求 Skill execute grant 和 Session shared state。先以 CAS 删除加载身份，再卸载当前作用域；可重试中断的清理，旧定义缺失不会阻止删除身份。服务层 `unloadSkill` 只修改活动作用域，需要持久语义的调用方应提交该 Effect。

`/llm/config` 提供 `.llm` 解析、导出、转换与纯 `composeLlmPresets(base, configs, options)`，不加载驱动、VFS、MCP 或内置目录。合并 Provider、连接、Agent 与定价，冲突默认 reject，可选 keep/replace；输入保持不变，Agent 静态时间戳默认 0，可用 timestamp 注入。Skills/MCP 仍通过管理服务导入。宿主负责增加 base.version 以更新已安装的默认连接。

例如：`new LLMDeviceDriver(vfs, { presets: composeLlmPresets({ version: 1 }, [parseLLMConfig(text)]) })`（驱动来自 `/llm/core`，配置函数来自 `/llm/config`）。旧 registerLLMConfig 仅用于兼容，需在旧驱动构造前调用。

`/llm/mcp-host` 提供 createMCPStdioTransportFactory(bridge)，每次连接创建独立 transport。通过 `/llm/core` 驱动的 `mcp: { stdioTransport: factory }` 注入；`false` 显式禁止 stdio，省略时仅 Node 可用。工厂失败直接传播，不回退。设置 UI 通过管理服务 supportsMCPStdio() 查询实例能力，缺省不可用。全局 MCP 注册 API 已删除，所有宿主显式持有自己的工厂。

MCPConnectionOptions 同时接受 logger（debug/info/warn/error）和 clientInfo（name/version）。默认空日志及通用 mcp-client 身份；clientInfo 在构造时复制、冻结并验证。app-core 显式提供 MindOS 身份和应用日志，其他实例互不覆盖。

运行时诊断通过 KernelAdaptersRuntimeOptions.logger 与 processUnavailableMessage 注入，缺省静默日志及英文提示。Effect 不读取 common 的全局日志或翻译；app-core 负责 MindOS 诊断装配。本包已移除 common 运行依赖。

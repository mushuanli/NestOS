# @itookit/tools

原生 TypeScript 工具执行模块，包含文件、搜索、Shell、Skill 和子代理工具。文件系统、命令执行及外部服务由宿主注入。

## 最小接入

```ts
import { createSkillTool, ToolDeviceDriver } from '@itookit/tools';
import type { SkillLoaderPort } from '@itookit/tools/contracts';

const loader: SkillLoaderPort = {
  async loadSkill(id) {
    return { success: true, toolIds: [`${id}_read`] };
  },
};

const driver = new ToolDeviceDriver([createSkillTool(loader)]);
await driver.init();
try {
  const result = await driver.invoke({ toolId: 'Skill', args: { skill_id: 'review' } });
  console.log(result.output);
} finally {
  await driver.dispose();
}
```

这个示例演示加载端口接入；实际加载器负责激活对应工具。`createAgentTool` 接收 `AgentDelegationPort`，只要求 `delegate()`。现有完整 SkillService、SubAgentRouter 仍可直接传入。

## 公共接口

`@itookit/tools/contracts` 是纯类型入口，不注册工具、不加载 Zod 或 Node 驱动，提供：

- `IToolService`、`ToolMeta`、`ToolInvokeRequest`、`ToolInvokeResult`、`ToolHandler`。
- `ToolVFSContext`：文件读写、列表和可选的惰性遍历。
- `ITTYDriver`、`ITTYSession`、`ITTYSessionManager`：平台无关的进程交互接口。
- `SkillLoaderPort`、`AgentDelegationPort`：外部能力的最小接入接口。

Node TTY 实现位于 `@itookit/device-tty`。其他环境可实现同一接口，无需继承 Node 驱动。

本包依赖 Zod、vfs-core、llm-context 和 driver-llm，已移除 common/llm-common 依赖。`common` 不再转发 Tool/TTY、Skill 和子代理类型，原 `llm-common` 已删除；新代码使用契约所属模块。

`tools/contracts` 也导出 `SkillDefinition`、`ISkillService`、Skill 版本/作用域契约及 `ISubAgentRouter`。`tools/mcp-contracts` 导出 MCPServer、MCPDiscovery、协议版本和 `mcpTimeoutMs`；不包含传输实现或 SDK。

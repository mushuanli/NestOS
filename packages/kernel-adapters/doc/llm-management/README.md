# kernel-adapters 模型管理

MindOS 的 LLM 宿主集成层。独立模型通信请使用 `@itookit/driver-llm`。

本包承接旧 device-llm 的 VFS 设备接口、Provider/Connection 配置、费用记录、默认 Agent、系统提示词、Skill、MCP 和 `.llm` 配置导入导出。

```ts
import { LLMDeviceDriver } from '@itookit/kernel-adapters/llm/core';
import { createMindosLlmPresets } from '@itookit/kernel-adapters/llm/presets';

const driver = new LLMDeviceDriver(vfs, { llmLogger, presets: createMindosLlmPresets() });
await driver.init();
// 通过原有 VFS 设备和管理接口使用，退出时调用 driver.dispose()。
```

配置路径、ioctl、设备会话和持久数据格式保持原有语义；现有配置无需迁移。MCP stdio 由 Node 或宿主桥提供，浏览器条件入口不加载 Node transport。

配置目录按每批最多 8 个文件并发读取，返回顺序保持目录顺序；空文件、解析失败与验证失败的配置仍逐项跳过。远程 HTTP VFS 经高延迟链路访问时，可减少逐文件串行等待。

详见 [设备协议](./driver-details.md)。

机制入口的宿主接入采用实例选项：

```ts
import { LLMDeviceDriver } from '@itookit/kernel-adapters/llm/core';
import { createMCPStdioTransportFactory } from '@itookit/kernel-adapters/llm/mcp-host';

const stdioTransport = createMCPStdioTransportFactory(processBridge);
const driver = new LLMDeviceDriver(vfs, { mcp: { stdioTransport } });
await driver.init();
```

processBridge 实现 start/send/poll/stop；每条连接独立持有进程，driver.dispose() 负责关闭。ApplicationRuntimeOptions.mcp 同样接收此选项。`stdioTransport: false` 禁止 stdio；省略时 Node 使用原生 transport，浏览器拒绝。注入工厂失败不会回退到其他宿主。设置 UI 查询服务的 supportsMCPStdio()，不读取全局注册。已删除全局 MCP 注册和旧聚合入口；独立 MCPClient/MCPServerConnection 的第二个参数使用相同选项。

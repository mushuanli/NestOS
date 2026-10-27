# kernel-adapters 模型管理

NestOS 的 LLM 宿主集成层。独立模型通信请使用 `@itookit/driver-llm`。

本包提供 VFS 设备接口、Provider/Connection 配置、费用记录、默认 Agent、系统提示词、Skill、MCP 和 `.llm` 配置导入导出；Provider 支持目录由独立的 `@itookit/device-llm` 提供。

```ts
import { LLMDeviceDriver } from '@itookit/kernel-adapters/llm/core';
import { createNestosLlmPresets } from '@itookit/kernel-adapters/llm/presets';

const driver = new LLMDeviceDriver(vfs, { llmLogger, presets: createNestosLlmPresets() });
await driver.init();
// 通过原有 VFS 设备和管理接口使用，退出时调用 driver.dispose()。
```

配置路径、ioctl、设备会话和持久数据格式保持原有语义；现有配置无需迁移。MCP stdio 由 Node 或宿主桥提供，浏览器条件入口不加载 Node transport。

配置目录按每批最多 8 个文件并发读取，返回顺序保持目录顺序；空文件、解析失败与验证失败的配置仍逐项跳过。远程 HTTP VFS 经高延迟链路访问时，可减少逐文件串行等待。

Provider、模型 ID、模型能力、厂商接口资料及价格统一归 `backend/device-llm` 的设备支持目录维护。`createLlmDeviceCatalog()` 提供独立快照，宿主经预设注入管理机制；通信库负责解析接口明确声明的能力，UI 通过管理服务读取并展示。旧常量目录和全局注册入口已移除。

厂商参考价格位于 [model-prices.json](../../../device-llm/src/catalogs/model-prices.json)，覆盖全部内置 Provider，记录来源、核对日期、币种、计费单位、精确模型 ID 和价格条件。`getPricingConfig().reference_catalog` 返回宿主目录副本，与用户可编辑的 `model_pricing` 账本费率分开；目录更新不回算历史费用、不改变连接绑定。OpenRouter 的公开模型 API 可提供价格；方舟普通 `/models` 不能保证带有单价，官方价格查询与网站价目表另行提供收费项。当前目录是人工核对的快照，运行时不抓取网站、不自动访问账户价格接口。

参考价默认采用常规文本推理的输入/输出费率，保留长度分档与峰谷时段；图片保留每张价格，语音保留每万字符价格，视频 token 另行标明，不自动换汇。未核实的精确型号标为待核实；动态路由按实际模型计价，账户/订阅入口说明对应模式，不用上游直供价冒充代理价格。维护时先核实来源与型号映射，再更新单价、条件和 reviewedAt；新内置 Provider 须同步补目录记录。

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

# @itookit/common

通用工具、日志、导航接口、i18n 和图标元数据，无运行时包依赖。

```ts
import { sha256Hex, escapeHTML, createModuleLogger, t } from '@itookit/common';

const digest = await sha256Hex('content');
const log = createModuleLogger('example');
log.info('Content ready', { digest });
```

SHA-256 支持字符串、ArrayBuffer 和字节视图；WebCrypto 不可用时使用纯 JavaScript 实现。

## LLM 导入迁移

本次变更移除了 common 的 LLM 兼容导出，不兼容旧的导入路径。原 llm-common 包也已删除。调用方应从定义所属模块导入，并在 package.json 声明直接依赖。

| 功能 | 公共入口 |
| --- | --- |
| Provider、Connection、模型通信、协议与模型事件 | `@itookit/driver-llm/contracts` |
| 消息、工具定义、上下文 | `@itookit/llm-context` |
| Tool、TTY、Skill、子代理、Prompt 库契约 | `@itookit/tools/contracts` |
| MCP 配置与发现 | `@itookit/tools/mcp-contracts` |
| 执行事件、节点配置与默认值 | `@itookit/llm-tasks/contracts` |
| Flow/DAG、委派、模板与派发 | `@itookit/llm-flow/contracts` |
| 会话、命令总线与扩展 | `@itookit/llm-session/contracts` |
| Agent/连接管理、恢复、定价与纯配置策略 | `@itookit/kernel-adapters/contracts` |

```ts
import { t } from '@itookit/common';
import type { ChatMessage } from '@itookit/llm-context';
import type { LLMProvider } from '@itookit/driver-llm/contracts';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
```

这些 contracts 入口不初始化宿主运行时、适配器或 UI。

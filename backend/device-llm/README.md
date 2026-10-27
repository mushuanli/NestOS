# @itookit/device-llm

LLM device 的 Provider 支持定义、模型能力、媒体约束、接口资料和价格目录。内置 Provider 在此统一维护，设备支持与账户授权分别判断。当前包位于主仓库的 backend 工作区。

```ts
import {createLlmDeviceCatalog, supportsLlmProvider} from '@itookit/device-llm';
import {resolveModelReferencePrice} from '@itookit/device-llm/contracts';

const catalog = createLlmDeviceCatalog();
const supported = supportsLlmProvider('volcengine');
const price = resolveModelReferencePrice(catalog.pricing.reference_catalog, 'volcengine', 'doubao-seedream-5-0-flash-260915');
```

每次创建返回独立快照。宿主按公开契约装配设备配置并保存用户覆盖，前端经管理服务读取安全元数据。`/contracts` 不加载目录；厂商定义及带来源、日期、币种和单位的价格只在根入口加载。

`driver-llm` 负责通信与厂商 API 字段解析；`kernel-adapters` 消费此包装配设备管理与 Effect；NestOS 的默认连接、Agent 和用户凭据由宿主提供。

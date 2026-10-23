# @itookit/device-llm

LLM device 的 Provider 支持目录：统一拥有内置 Provider、模型能力、推理与媒体操作声明、接口资料和价格。通信实现与厂家目录字段解析继续使用 driver-llm 的公开契约；目录表示设备支持，不表示账户授权或凭据就绪。

- 根入口通过 createLlmDeviceCatalog 返回独立快照；不得提供可变全局注册表，用户配置由宿主合并和持久化。
- `/contracts` 仅类型与纯函数，不能加载 JSON 目录、网络客户端、VFS、应用配置或 UI。
- `/contracts` 的 modelOutputFormats/assertModelOutputFormats 以当前协议及模型显式 supportsStructuredOutput 声明求有效输出模式；未知不推断，anthropic-messages 不支持 json_object，提示词 JSON 使用 text 并由上层本地 schema 校验。纯 helper 不改请求格式、不选择模型、不发起请求。
- 唯一工作区依赖为 driver-llm；不得反向依赖 kernel-adapters、common、Session、Flow、app-core 或 UI。
- 厂家原始资料及核对日期保存在 src/catalogs；区分 implemented/partial/unsupported、未知与免费，模型 ID 精确匹配，不按名称猜能力或价格。
- App 的 Agent、默认连接选择、VFS 路径与用户密钥由宿主拥有，不进入设备支持目录。

验证：`pnpm --filter @itookit/device-llm test`、`typecheck`、`build`；构建自动检查 ESM/CJS 入口隔离。

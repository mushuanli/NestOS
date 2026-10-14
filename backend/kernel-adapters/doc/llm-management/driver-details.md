# driver-llm 驱动详情

## LLMDeviceDriver ioctl 命令

| 命令 | 功能 |
|---|---|
| `list-connections` | 列出连接（无 apiKey） |
| `get-full-connection` | 获取完整连接（含 apiKey） |
| `save-connection` | 保存连接 |
| `delete-connection` | 删除连接 |
| `test-connection-params` | 测试连接 |
| `list-mcp-servers` / `save-mcp-server` | MCP 管理 |
| `list-skills` / `save-skill` / `delete-skill` | Skill CRUD |

存储路径：`/llm/.connections/` `/llm/.providers/` `/llm/.mcp/` `/llm/.skills/`

## LLMDriver

核心调用引擎，管理三种 session：`createChatSession` → `LLMChain` / `createMCPSession` → `MCPServerConnection` / `createSkillSession` → Skill 执行

## Message Content Types

`MessageContentPart` discriminated union：
`MessageContentText` | `MessageContentImage` | `MessageContentAudio` | `MessageContentVideo` | `MessageContentFile` | `MessageContentToolResult` | `MessageContentCodeExecution` | `MessageContentCitation`

## 请求超时与取消

LLMDriver 使用 RequestCancellation 区分内部 TIMEOUT 与调用方 ABORTED，保留先发生的原因，避免传输层通用 AbortError 丢失超时语义。非流式使用总响应期限；流式首块前使用首响应期限，之后每块重置停顿期限。请求在调用前已取消则不派发，超时后不在同一已失效 signal 上继续重试；调用方可以显式发起新请求。完成/失败/消费者结束迭代时移除外部取消监听器和计时器。设备必须响应 signal；没有用提前返回的 Promise.race 代替设备停止确认。回归见 [取消回归](https://github.com/mushuanli/driver-llm/blob/main/tests/driver-cancellation.spec.ts)。

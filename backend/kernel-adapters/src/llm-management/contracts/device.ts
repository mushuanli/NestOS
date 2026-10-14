export const LLM_IOCTL = {
    // ── 连接管理（无需 sessionId）────────────────────────────────────────────
    /** → ConnectionMeta[]（无 apiKey） */
    LIST_CONNECTIONS:         'list-connections',
    /** arg: id → ConnectionMeta | null */
    GET_CONNECTION_META:      'get-connection',
    /** → ConnectionMeta | null（第一个或 id='default'） */
    GET_DEFAULT_CONNECTION:   'get-default-connection',
    /** arg: id → LLMConnection | null（含 apiKey，仅供 Settings UI 编辑使用） */
    GET_FULL_CONNECTION:      'get-full-connection',
    /** arg: LLMConnection → void（保存连接，含 apiKey） */
    SAVE_CONNECTION:          'save-connection',
    /** arg: id → void */
    DELETE_CONNECTION:        'delete-connection',
    /** arg: { provider, apiKey, baseURL?, model? } → ConnectionTestResult */
    TEST_CONNECTION_PARAMS:   'test-connection-params',

    // ── MCP 服务器管理（无需 sessionId）─────────────────────────────────────
    /** → MCPServer[] */
    LIST_MCP_SERVERS:         'list-mcp-servers',
    /** arg: MCPServer → void */
    SAVE_MCP_SERVER:          'save-mcp-server',
    /** arg: id → void */
    DELETE_MCP_SERVER:        'delete-mcp-server',
    /** arg: id → void — 连接指定 MCP 服务器 */
    CONNECT_MCP_SERVER:       'connect-mcp-server',
    /** arg: id → void — 断开指定 MCP 服务器 */
    DISCONNECT_MCP_SERVER:    'disconnect-mcp-server',

    // ── Chat 会话（需要 sessionId）───────────────────────────────────────────
    CHAT:             'chat',
    CHAT_SYNC:        'chat-sync',
    GET_HISTORY:      'get-history',
    CLEAR_HISTORY:    'clear-history',
    GET_MODELS:       'get-models',
    ABORT:            'abort',
    SET_SYSTEM_PROMPT:'set-system-prompt',

    // ── MCP 会话（需要 sessionId，由 /dev/llm/mcp/<id> 打开）────────────────
    /** → ToolDefinition[] */
    MCP_LIST_TOOLS:   'list-tools',
    /** arg: { tool: string; args: Record<string,any>; timeout?: number } → any */
    MCP_CALL_TOOL:    'call-tool',
    MCP_DISCOVER:     'mcp-discover',
    MCP_READ_RESOURCE: 'mcp-read-resource',
    MCP_GET_PROMPT:    'mcp-get-prompt',

    // ── Provider 管理（无需 sessionId）──────────────────────────────────────
    /** → LLMProvider[]（不含 apiKey） */
    LIST_PROVIDERS:       'list-providers',
    /** arg: id → LLMProvider | null（不含 apiKey，含模型定价） */
    GET_PROVIDER:         'get-provider',
    /** arg: id → LLMProvider | null（含 apiKey，仅供 Settings UI） */
    GET_FULL_PROVIDER:    'get-full-provider',
    /** arg: LLMProvider → void（保存，含 apiKey） */
    SAVE_PROVIDER:        'save-provider',
    /** arg: id → void */
    DELETE_PROVIDER:      'delete-provider',

    // ── Skill 管理（无需 sessionId）──────────────────────────────────────────
    /** → LLMSkill[] */
    LIST_SKILLS:      'list-skills',
    /** arg: LLMSkill → void */
    SAVE_SKILL:       'save-skill',
    /** arg: id → void */
    DELETE_SKILL:     'delete-skill',

    // ── Cost 查询（无需 sessionId）───────────────────────────────────────────
    /** arg: sessionId → CostRecord[] */
    QUERY_COSTS_BY_SESSION:  'query-costs-by-session',
    /** arg: { providerId, dateFrom?, dateTo? } → CostRecord[] */
    QUERY_COSTS_BY_PROVIDER: 'query-costs-by-provider',
    /** arg: { dateFrom?, dateTo?, providerId? } → CostRecord[] */
    QUERY_COSTS_ALL:         'query-costs-all',

    // ── Skill 会话（需要 sessionId，由 /dev/llm/skills/<id> 打开）────────────
    /** arg: { args: Record<string,unknown> } → unknown — 调用 HTTP 端点 */
    SKILL_INVOKE:     'invoke',
    /** → LLMSkill — 读取当前 skill 配置 */
    SKILL_GET_DEF:    'get-definition',
} as const;

export type LLMIoctlCommand = typeof LLM_IOCTL[keyof typeof LLM_IOCTL];

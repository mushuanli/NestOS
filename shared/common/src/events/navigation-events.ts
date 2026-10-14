// @file: common/events/navigation-events.ts

/**
 * 标准导航事件名称常量
 * 所有模块使用统一的事件名称
 */
export const NAVIGATION_EVENTS = {
    /** 请求打开 Agent 配置 */
    OPEN_AGENT_CONFIG: 'app:navigate:agent-config',
    /** 请求打开连接设置 */
    OPEN_CONNECTION_SETTINGS: 'app:navigate:connection-settings',
    /** 请求打开 MCP 设置 */
    OPEN_MCP_SETTINGS: 'app:navigate:mcp-settings',
    /** 请求创建新会话 */
    CREATE_CHAT_SESSION: 'app:navigate:create-chat',
    /** 通用导航请求 */
    NAVIGATE: 'app:navigate',
} as const;

/**
 * 导航事件 Payload 类型
 */
export interface NavigationEventPayload {
    target: string;
    resourceId?: string;
    params?: Record<string, unknown>;
}

/**
 * 创建类型安全的导航事件
 */
export function createNavigationEvent(
    payload: NavigationEventPayload
): CustomEvent<NavigationEventPayload> {
    return new CustomEvent(NAVIGATION_EVENTS.NAVIGATE, {
        bubbles: true,
        composed: true,
        detail: payload
    });
}

/**
 * 创建 Agent 配置打开事件
 */
export function createOpenAgentEvent(agentId: string): CustomEvent {
    return new CustomEvent(NAVIGATION_EVENTS.OPEN_AGENT_CONFIG, {
        bubbles: true,
        composed: true,
        detail: { agentId }
    });
}

/**
 * 创建新会话事件
 */
export function createChatSessionEvent(
    options?: { agentId?: string; text?: string }
): CustomEvent {
    return new CustomEvent(NAVIGATION_EVENTS.CREATE_CHAT_SESSION, {
        bubbles: true,
        composed: true,
        detail: options || {}
    });
}

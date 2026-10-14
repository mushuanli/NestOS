import type { LLMConnection, LLMProvider } from '@itookit/driver-llm/contracts';
import type { MCPServer } from '@itookit/tools/mcp-contracts';
import type { ChatMessage } from '@itookit/llm-context';
import { LLM_IOCTL } from '../contracts/device';

const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate'];
const ID_COMMANDS = new Set<string>([LLM_IOCTL.GET_CONNECTION_META, LLM_IOCTL.GET_FULL_CONNECTION,
    LLM_IOCTL.DELETE_CONNECTION, LLM_IOCTL.DELETE_PROVIDER, LLM_IOCTL.GET_PROVIDER, LLM_IOCTL.GET_FULL_PROVIDER,
    LLM_IOCTL.DELETE_MCP_SERVER, LLM_IOCTL.CONNECT_MCP_SERVER, LLM_IOCTL.DISCONNECT_MCP_SERVER,
    LLM_IOCTL.DELETE_SKILL, LLM_IOCTL.QUERY_COSTS_BY_SESSION]);

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === 'string';
const identifier = (value: unknown): value is string => text(value) && Boolean(value.trim());
const storageId = (value: unknown): value is string => identifier(value) && !/[\\/\0]/.test(value) && value !== '.' && value !== '..';
const enumValue = (value: unknown, values: string[]) => text(value) && values.includes(value);
const optional = (value: unknown, validate: (value: unknown) => boolean) => value === undefined || validate(value);
const stringMap = (value: unknown) => isRecord(value) && Object.values(value).every(text);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const protocol = (value: unknown) => text(value) && PROTOCOLS.includes(value);

/** Validate storage identities and fields consumed by connection resolution. */
export function isConnection(value: unknown): value is LLMConnection {
    return isRecord(value) && storageId(value.id) && text(value.name) && storageId(value.providerId)
        && optional(value.protocol, protocol) && optional(value.tiers, stringMap)
        && optional(value.metadata, isRecord) && optional(value.temperature, finite)
        && optional(value.enabled, value => typeof value === 'boolean')
        && ['apiKey', 'model', 'baseURL'].every(key => optional(value[key], text));
}

/** Deletion records retain their identity even when the remaining catalog is absent. */
export function isStoredProvider(value: unknown): value is LLMProvider {
    return isRecord(value) && storageId(value.id) && (value.__deleted === true || isProvider(value));
}

export function isProvider(value: unknown): value is LLMProvider {
    return isRecord(value) && storageId(value.id) && text(value.name) && text(value.baseURL)
        && enumValue(value.implementation, ['openai-compatible', 'anthropic', 'gemini', 'custom'])
        && Array.isArray(value.models) && value.models.every(model => isRecord(model) && identifier(model.id))
        && optional(value.defaultProtocol, protocol)
        && optional(value.supportedProtocols, value => Array.isArray(value) && value.every(protocol))
        && optional(value.capabilities, isRecord) && optional(value.defaultTiers, stringMap)
        && ['apiKey', 'defaultPath', 'chatPath', 'anthropicPath', 'responsesPath', 'geminiPath', 'modelsPath'].every(key => optional(value[key], text))
        && optional(value.enabled, value => typeof value === 'boolean');
}

export function isMCPServer(value: unknown): value is MCPServer {
    return isRecord(value) && storageId(value.id) && identifier(value.name)
        && enumValue(value.transport, ['stdio', 'http'])
        && optional(value.headers, stringMap) && optional(value.env, stringMap)
        && optional(value.command, text) && optional(value.endpoint, text) && optional(value.args, text)
        && optional(value.timeout, value => finite(value) && Number(value) > 0)
        && ['apiKey', 'cwd'].every(key => optional(value[key], text))
        && optional(value.autoConnect, value => typeof value === 'boolean');
}

export function isChatMessage(value: unknown): value is ChatMessage {
    return isRecord(value) && enumValue(value.role, ['system', 'user', 'assistant', 'tool', 'developer'])
        && (text(value.content) || (Array.isArray(value.content) && value.content.every(part => isRecord(part) && identifier(part.type))))
        && optional(value.attachments, Array.isArray) && optional(value.tool_calls, Array.isArray);
}

/** Fail at the device boundary, before configuration writes, requests, or cancellation. */
export function validateLLMIoctlArgument(command: string | number, value: unknown): void {
    if (typeof command !== 'string') return;
    if (ID_COMMANDS.has(command)) return requireValue(command === LLM_IOCTL.QUERY_COSTS_BY_SESSION ? identifier(value) : storageId(value), command);
    const validate = Object.hasOwn(validators, command) ? validators[command] : undefined;
    if (validate) requireValue(validate(value), command);
}

const validators: Record<string, (value: unknown) => boolean> = {
    [LLM_IOCTL.SAVE_CONNECTION]: isConnection,
    [LLM_IOCTL.SAVE_PROVIDER]: isProvider,
    [LLM_IOCTL.SAVE_MCP_SERVER]: isMCPServer,
    [LLM_IOCTL.SAVE_SKILL]: isRecord,
    [LLM_IOCTL.TEST_CONNECTION_PARAMS]: value => isRecord(value) && identifier(value.provider)
        && optional(value.apiKey, text) && optional(value.baseURL, text) && optional(value.model, text)
        && optional(value.protocol, protocol) && optional(value.providerDefinition, isProvider),
    [LLM_IOCTL.CHAT]: isChatRequest,
    [LLM_IOCTL.CHAT_SYNC]: isChatRequest,
    [LLM_IOCTL.SET_SYSTEM_PROMPT]: value => optional(value, text),
    [LLM_IOCTL.MCP_READ_RESOURCE]: value => isRecord(value) && identifier(value.uri) && optional(value.signal, isAbortSignal),
    [LLM_IOCTL.MCP_GET_PROMPT]: value => isRecord(value) && identifier(value.name)
        && optional(value.args, stringMap) && optional(value.signal, isAbortSignal),
    [LLM_IOCTL.MCP_CALL_TOOL]: value => isRecord(value) && identifier(value.tool) && isRecord(value.args)
        && optional(value.timeout, value => finite(value) && Number(value) > 0)
        && optional(value.signal, isAbortSignal) && optional(value.onProgress, value => typeof value === 'function'),
    [LLM_IOCTL.SKILL_INVOKE]: value => isRecord(value) && isRecord(value.args),
    [LLM_IOCTL.QUERY_COSTS_BY_PROVIDER]: value => isRecord(value) && storageId(value.providerId) && isCostFilter(value),
    [LLM_IOCTL.QUERY_COSTS_ALL]: value => optional(value, isCostFilter),
};

function isChatRequest(value: unknown): boolean {
    return isRecord(value) && Array.isArray(value.messages) && value.messages.every(isChatMessage)
        && optional(value.model, text) && optional(value.stream, value => typeof value === 'boolean')
        && optional(value.signal, isAbortSignal) && optional(value.tools, Array.isArray)
        && ['temperature', 'maxTokens', 'topP', 'thinkingBudget', '_maxAttempts'].every(key => optional(value[key], finite));
}
function isAbortSignal(value: unknown): boolean {
    return isRecord(value) && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function';
}
function isCostFilter(value: unknown): boolean {
    return isRecord(value) && ['providerId', 'dateFrom', 'dateTo'].every(key => optional(value[key], text));
}
function requireValue(valid: boolean, command: string): void {
    if (!valid) throw new TypeError(`Invalid LLM ioctl argument: ${command}`);
}

import {t} from '@itookit/common';
import type {IPrivilegedCommandService} from '@itookit/llm-session/contracts';
import type {JsonValue} from '@itookit/llm-flow/contracts';
import {promptToolCall, type ToolCallValue} from './tool-call-form';

/** Direct arguments and the visual picker use the same durable command port. */
export async function prepareToolInvocation(service: IPrivilegedCommandService, sessionId: string, text: string,
    signal: AbortSignal, mcpOnly = false): Promise<ToolCallValue | null> {
    if (!service.tools || !service.tool) throw new Error(t('flow.tool.unavailable'));
    const tools = await service.tools(sessionId);
    if (signal.aborted) return null;
    const match = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const selected = match ? tools.find(tool => tool.id === match[1]) : undefined;
    if (match && (!selected || mcpOnly && !selected.id.startsWith('mcp__'))) throw new Error(t('flow.tool.required'));
    if (selected && match?.[2]) {
        const args: unknown = JSON.parse(match[2]);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(t('flow.invoke.arguments'));
        return {toolId: selected.id, toolVersion: selected.version ?? '1', args: args as Record<string, JsonValue>};
    }
    return promptToolCall(tools, {signal, mcpOnly,
        ...(selected ? {initial: {toolId: selected.id, toolVersion: selected.version ?? '1', args: {}}} : {})});
}

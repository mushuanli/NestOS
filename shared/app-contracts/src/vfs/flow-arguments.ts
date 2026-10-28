import {ResourceCommand, type ResourceContent, type ResourceScope} from './resource-reference';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import type {FlowParameter, JsonValue} from '@itookit/llm-flow/contracts';

/** Quotes group one argument; no shell interpolation or escape evaluation is performed. */
export function flowArgumentTokens(text: string): string[] {
    const tokens = text.match(/(?:[^\s"']|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
    if (tokens.join('').replace(/\s/g, '') !== text.replace(/\s/g, '')) throw new Error('FLOW_ARGUMENT_QUOTES_INVALID');
    return tokens;
}
export async function resolveFlowArguments(text: string, fields: FlowParameter[], commands: ICommandBus, scope: ResourceScope, signal?: AbortSignal): Promise<Record<string, JsonValue>> {
    if (!text.trim()) return {};
    if (text.trim().startsWith('{')) {
        const values = JSON.parse(text);
        if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('FLOW_ARGUMENT_OBJECT_REQUIRED');
        for (const key of Object.keys(values)) if (!fields.some(field => field.name === key)) throw new Error(`Unknown Flow parameter: ${key}`);
        return values;
    }
    const values: Record<string, JsonValue> = {}; let position = 0;
    for (const token of flowArgumentTokens(text)) {
        signal?.throwIfAborted();
        const match = /^([A-Za-z_][\w.-]*)=(.*)$/s.exec(token);
        const field = match ? fields.find(field => field.name === match[1]) : fields[position++];
        if (!field) throw new Error(`Unknown or excess Flow parameter: ${match?.[1] ?? position}`);
        if (Object.hasOwn(values, field.name)) throw new Error(`Duplicate Flow parameter: ${field.name}`);
        let raw = match?.[2] ?? token;
        if (raw.startsWith('@')) raw = (await commands.execute<ResourceContent>(ResourceCommand.Read, {reference: raw, scope})).text;
        else if (raw.startsWith('"')) raw = JSON.parse(raw);
        else if (raw.startsWith("'")) raw = raw.slice(1, -1);
        signal?.throwIfAborted(); values[field.name] = parameterSourceValue(raw, field);
    }
    return values;
}
export function parameterSourceValue(value: unknown, field: FlowParameter): JsonValue {
    if (field.type !== 'string' && typeof value === 'string') {
        try {value = JSON.parse(value);} catch {throw new Error(`Invalid ${field.type}: ${field.label ?? field.name}`);}
    }
    if (field.type !== 'json' && typeof value !== field.type) throw new Error(`Expected ${field.type}: ${field.label ?? field.name}`);
    return value as JsonValue;
}

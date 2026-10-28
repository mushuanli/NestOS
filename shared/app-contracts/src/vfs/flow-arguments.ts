import {createModuleLogger, randomUUID} from '@itookit/common';
import {ResourceCommand, type ResourceMediaContent, type ResourceScope} from './resource-reference';
import {InputAssetCommand} from '../presets/input-assets';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import type {FlowParameter, JsonValue} from '@itookit/llm-flow/contracts';

const log = createModuleLogger('flow-arguments');
type Values = Record<string, JsonValue>;
/** Quotes group one argument; no shell interpolation or escape evaluation is performed. */
export function flowArgumentTokens(text: string): string[] {
    const tokens = text.match(/(?:[^\s"']|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
    if (tokens.join('').replace(/\s/g, '') !== text.replace(/\s/g, '')) throw new Error('FLOW_ARGUMENT_QUOTES_INVALID');
    return tokens;
}
export async function resolveFlowArguments(text: string, fields: FlowParameter[], commands: ICommandBus, scope: ResourceScope, signal?: AbortSignal): Promise<Values> {
    if (!text.trim()) return {};
    if (text.trim().startsWith('{')) return jsonArguments(text, fields);
    const values: Values = {};
    for (const token of flowArgumentTokens(text)) {
        signal?.throwIfAborted();
        const match = /^([A-Za-z_][\w.-]*)=(.*)$/s.exec(token), raw = match?.[2] ?? token;
        const named = match ? fields.find(field => field.name === match[1]) : undefined;
        if (match && !named) throw new Error(`Unknown Flow parameter: ${match[1]}`);
        if (named && Object.hasOwn(values, named.name)) throw new Error(`Duplicate Flow parameter: ${named.name}`);
        if (raw.startsWith('@')) await bindReference(raw, named, fields, values, commands, scope, signal);
        else {
            const field = named ?? nextField(fields, values);
            values[field.name] = parameterSourceValue(raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1) : raw, field);
        }
        signal?.throwIfAborted();
    }
    return values;
}
function jsonArguments(text: string, fields: FlowParameter[]): Values {
    const values = JSON.parse(text);
    if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('FLOW_ARGUMENT_OBJECT_REQUIRED');
    for (const key of Object.keys(values)) if (!fields.some(field => field.name === key)) throw new Error(`Unknown Flow parameter: ${key}`);
    return values;
}
function nextField(fields: FlowParameter[], values: Values): FlowParameter {
    const field = fields.find(field => !Object.hasOwn(values, field.name));
    if (!field) throw new Error('Unknown or excess Flow parameter');
    return field;
}
async function bindReference(reference: string, named: FlowParameter | undefined, fields: FlowParameter[], values: Values,
    commands: ICommandBus, scope: ResourceScope, signal?: AbortSignal): Promise<void> {
    const resource = await commands.execute<ResourceMediaContent>(ResourceCommand.Read, {reference, scope, mode: 'auto'});
    signal?.throwIfAborted();
    if (typeof resource.text === 'string' && (!named || !mediaField(named))) {
        const field = named ?? nextField(fields, values);
        if (resource.bytes > 2 * 1024 * 1024) throw failure('FLOW_ARGUMENT_TEXT_LIMIT', 'Referenced text exceeds 2 MiB; use a files parameter for larger documents');
        values[field.name] = parameterSourceValue(resource.text, field); return;
    }
    const field = named ?? mediaTarget(resource, fields);
    if (!acceptsMedia(field, resource.mimeType)) throw failure('FLOW_ARGUMENT_MEDIA_MISMATCH', `${field.label ?? field.name} does not accept ${resource.mimeType}; use an images or files parameter`);
    const previous = values[field.name];
    const parts: JsonValue[] = previous === undefined ? [] : Array.isArray(previous) ? previous : [];
    if (previous !== undefined && !Array.isArray(previous)) throw failure('FLOW_ARGUMENT_MEDIA_MISMATCH', `Invalid attachment parameter: ${field.name}`);
    checkMediaBounds(field, parts, resource);
    const part = await importMedia(resource, field, commands);
    signal?.throwIfAborted(); values[field.name] = [...parts, part];
}
function mediaField(field: FlowParameter): boolean { return field.type === 'json' && (field.widget === 'images' || field.widget === 'files'); }
function acceptsMedia(field: FlowParameter, mimeType: string): boolean {
    if (!mediaField(field) || field.widget === 'images' && !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) return false;
    const constraints = field.widget === 'images' ? field.imageConstraints : field.fileConstraints;
    return !constraints?.mimeTypes || constraints.mimeTypes.some(type => type.toLowerCase() === mimeType.toLowerCase());
}
function mediaTarget(resource: ResourceMediaContent, fields: FlowParameter[]): FlowParameter {
    const candidates = fields.filter(field => acceptsMedia(field, resource.mimeType));
    if (candidates.length !== 1) throw failure(candidates.length ? 'FLOW_ARGUMENT_MEDIA_AMBIGUOUS' : 'FLOW_ARGUMENT_MEDIA_UNSUPPORTED', candidates.length
        ? `Multiple parameters accept ${resource.mimeType}: ${candidates.map(field => field.name).join(', ')}; use parameter=@/file`
        : `This Flow has no parameter accepting ${resource.mimeType}`);
    return candidates[0];
}
function checkMediaBounds(field: FlowParameter, parts: JsonValue[], resource: ResourceMediaContent): void {
    const constraints = field.widget === 'images' ? field.imageConstraints : field.fileConstraints;
    const bytes = parts.reduce<number>((total, part) => total + mediaBytes(part), resource.bytes);
    if (constraints?.maxItems !== undefined && parts.length + 1 > constraints.maxItems)
        throw failure('FLOW_ARGUMENT_MEDIA_LIMIT', `${field.label ?? field.name} accepts at most ${constraints.maxItems} files`);
    if (constraints?.maxBytes !== undefined && bytes > constraints.maxBytes)
        throw failure('FLOW_ARGUMENT_MEDIA_LIMIT', `${field.label ?? field.name} exceeds its ${constraints.maxBytes} byte limit`);
}
function mediaBytes(part: JsonValue): number {
    const value = part as {source?: {asset?: {bytes?: number}}; image_url?: {url?: string}};
    if (typeof value?.source?.asset?.bytes === 'number') return value.source.asset.bytes;
    const data = value?.image_url?.url?.split(',')[1];
    return data ? data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) : 0;
}
async function importMedia(resource: ResourceMediaContent, field: FlowParameter, commands: ICommandBus): Promise<JsonValue> {
    const operationId = randomUUID(), started = Date.now();
    try {
        const asset = await commands.execute<JsonValue>(InputAssetCommand.ImportFile, {uploadId: operationId, name: resource.name,
            mimeType: resource.mimeType, bytes: resource.bytes, sha256: resource.sha256, data: resource.data});
        validateAsset(asset, operationId, resource);
        log.info('flow.argument.media', {operationId, stage: 'import', result: 'success', parameter: field.name, mimeType: resource.mimeType, bytes: resource.bytes, durationMs: Date.now() - started});
        return {type: field.widget === 'images' ? 'image' : 'file', name: resource.name, source: {type: 'asset', asset}};
    } catch (error) {
        log.warn('flow.argument.media', {operationId, stage: 'import', result: 'failure', code: 'FLOW_ARGUMENT_ASSET_IMPORT_FAILED', durationMs: Date.now() - started}); throw error;
    }
}
function validateAsset(value: JsonValue, id: string, resource: ResourceMediaContent): void {
    const asset = value as Record<string, JsonValue> | null;
    if (!asset || asset.kind !== 'input' || asset.id !== id || asset.mimeType !== resource.mimeType
        || asset.bytes !== resource.bytes || asset.sha256 !== resource.sha256)
        throw failure('INPUT_ASSET_RECEIPT_INVALID', 'Imported file receipt differs from the referenced content');
}
function failure(code: string, message: string): Error { return Object.assign(new Error(message), {code}); }
export function parameterSourceValue(value: unknown, field: FlowParameter): JsonValue {
    if (field.type !== 'string' && typeof value === 'string') {
        try {value = JSON.parse(value);} catch {throw new Error(`Invalid ${field.type}: ${field.label ?? field.name}`);}
    }
    if (field.type !== 'json' && typeof value !== field.type) throw new Error(`Expected ${field.type}: ${field.label ?? field.name}`);
    return value as JsonValue;
}

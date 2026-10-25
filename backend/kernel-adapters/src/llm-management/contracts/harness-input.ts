import type {HarnessInputAttachment, HarnessInlineAttachment, HarnessAssetAttachment} from './harness-execution';
import {sha256HexSync} from '@itookit/llm-context/digest';

export interface HarnessInputMessage {role: string; content: unknown; attachments?: unknown[];}
export interface PreparedHarnessInput {prompt: string; attachments?: HarnessInputAttachment[];}

/** Preserve legacy text-only digests while including every new incremental file byte. */
export function harnessInputDigest(input: PreparedHarnessInput): string {
    return sha256HexSync(input.attachments?.length ? JSON.stringify(input) : input.prompt);
}

/** Normalize the frozen host message data without fetching URLs or opening files. */
export function prepareHarnessInput(input: {messages?: HarnessInputMessage[]; prompt?: string; attachments?: HarnessInputAttachment[]}): PreparedHarnessInput {
    validateShape(input);
    const attachments = (input.attachments ?? []).map(inlineAttachment);
    const source = input.messages ?? [{role: 'user', content: input.prompt ?? ''}];
    const messages = source.map(message => normalizeMessage(message, attachments));
    const unique = uniqueAttachments(attachments);
    return {prompt: formatPrompt(messages, unique), ...(unique.length ? {attachments: unique} : {})};
}

function uniqueAttachments(attachments: HarnessInputAttachment[]): HarnessInputAttachment[] {
    const unique = new Map<string, HarnessInputAttachment>();
    for (const file of attachments) {
        const previous = unique.get(file.name);
        if (previous && JSON.stringify(previous) !== JSON.stringify(file)) throw invalid('HARNESS_ATTACHMENT_NAME_CONFLICT');
        unique.set(file.name, file);
    }
    return [...unique.values()];
}

function formatPrompt(messages: Array<{role: string; content: string}>, attachments: HarnessInputAttachment[]): string {
    const prompt = messages.length === 1 && messages[0].role === 'user' ? messages[0].content : JSON.stringify({messages});
    return !prompt.trim() && attachments.length ? `Attachments: ${attachments.map(file => file.name).join(', ')}` : prompt;
}

function validateShape(input: {messages?: HarnessInputMessage[]; prompt?: string; attachments?: HarnessInputAttachment[]}): void {
    if (!input || typeof input !== 'object') throw invalid('HARNESS_INPUT_INVALID');
    if (input.messages !== undefined && !Array.isArray(input.messages)) throw invalid('HARNESS_MESSAGES_INVALID');
    if (input.prompt !== undefined && typeof input.prompt !== 'string') throw invalid('HARNESS_PROMPT_INVALID');
    if (input.attachments !== undefined && !Array.isArray(input.attachments)) throw invalid('HARNESS_ATTACHMENT_INVALID');
}

function normalizeMessage(message: HarnessInputMessage, attachments: HarnessInputAttachment[]) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) throw invalid('HARNESS_MESSAGE_ROLE_INVALID');
    let content: string;
    if (typeof message.content === 'string') content = message.content;
    else if (Array.isArray(message.content)) content = message.content.map(part => contentText(part, attachments)).join('\n');
    else throw invalid('HARNESS_MESSAGE_CONTENT_UNSUPPORTED');
    if (message.attachments !== undefined && !Array.isArray(message.attachments)) throw invalid('HARNESS_ATTACHMENT_INVALID');
    for (const attachment of message.attachments ?? []) attachments.push(inlineAttachment(attachment));
    return {role: message.role, content};
}

function inlineAttachment(value: unknown): HarnessInputAttachment {
    const file = record(value), source = record(file.source);
    if (isAssetSource(file, source)) return assetAttachment(file, file.asset ?? source.asset);
    const selected = {kind: file.kind ?? file.type, name: file.filename ?? file.name,
        content: file.content ?? file.source, mimeType: file.mimeType};
    if (!validInlineTypes(selected)) throw invalid('HARNESS_ATTACHMENT_INVALID');
    if (selected.kind === 'image' && !selected.content.startsWith('data:image/')) throw invalid('HARNESS_ATTACHMENT_INLINE_REQUIRED');
    return {kind: selected.kind, name: selected.name, content: selected.content,
        ...(selected.mimeType ? {mimeType: selected.mimeType} : {})};
}
function isAssetSource(file: Record<string, unknown>, source: Record<string, unknown>): boolean {
    return file.kind === 'asset' || source.type === 'asset';
}

function validInlineTypes(value: {kind: unknown; name: unknown; content: unknown; mimeType: unknown}): value is HarnessInlineAttachment & {mimeType: string | undefined} {
    return typeof value.kind === 'string' && ['text', 'image'].includes(value.kind) && typeof value.name === 'string'
        && !!value.name && typeof value.content === 'string' && (value.mimeType === undefined || typeof value.mimeType === 'string');
}

function contentText(value: unknown, attachments: HarnessInputAttachment[]): string {
    const part = record(value);
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    if (['image', 'file'].includes(String(part.type)) && record(part.source).type === 'asset') {
        const attachment = assetAttachment(part, record(part.source).asset);
        attachments.push(attachment);
        return `File attachment: ${attachment.name}`;
    }
    const url = record(part.image_url).url;
    if (part.type !== 'image_url' || typeof url !== 'string') throw invalid('HARNESS_MESSAGE_CONTENT_UNSUPPORTED');
    const mimeType = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(url)?.[1];
    if (!mimeType) throw invalid('HARNESS_ATTACHMENT_INLINE_REQUIRED');
    const name = `context-image-${attachments.length + 1}.${mimeType.split('/')[1]}`;
    attachments.push({kind: 'image', name, content: url, mimeType});
    return `Image attachment: ${name}`;
}

function assetAttachment(file: Record<string, unknown>, value: unknown): HarnessAssetAttachment {
    const asset = record(value);
    if (!validAssetMetadata(asset) || !validAssetIdentity(asset)) throw invalid('HARNESS_ASSET_REFERENCE_INVALID');
    if (assetSourceConflict(file, asset.mimeType)) throw invalid('HARNESS_ATTACHMENT_SOURCE_CONFLICT');
    const reference = canonicalAsset(asset);
    const name = file.filename ?? file.name ?? `asset-${sha256HexSync(JSON.stringify(reference)).slice(0, 24)}.${assetExtension(reference.mimeType)}`;
    if (typeof name !== 'string' || !name) throw invalid('HARNESS_ATTACHMENT_INVALID');
    return {kind: 'asset', name, asset: reference};
}
function assetSourceConflict(file: Record<string, unknown>, mimeType: unknown): boolean {
    return file.content !== undefined || typeof file.source === 'string' || file.mimeType !== undefined && file.mimeType !== mimeType;
}
function canonicalAsset(value: Record<string, unknown>): HarnessAssetAttachment['asset'] {
    const asset = value as unknown as HarnessAssetAttachment['asset'];
    const metadata = {mimeType: asset.mimeType, bytes: asset.bytes, sha256: asset.sha256};
    return 'kind' in asset ? {kind: 'input', id: asset.id, ...metadata}
        : {sessionId: asset.sessionId, taskId: asset.taskId, owner: asset.owner, name: asset.name, ...metadata};
}
function validAssetMetadata(asset: Record<string, unknown>): boolean {
    return typeof asset.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(asset.mimeType)
        && Number.isSafeInteger(asset.bytes) && Number(asset.bytes) >= 0
        && typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256);
}
function validAssetIdentity(asset: Record<string, unknown>): boolean {
    if (asset.kind === 'input') return typeof asset.id === 'string' && /^[a-f0-9-]{36}$/.test(asset.id);
    return asset.kind === undefined && ['sessionId', 'taskId', 'owner', 'name'].every(key => typeof asset[key] === 'string' && !!asset[key]);
}
function assetExtension(mime: string): string {
    if (mime === 'image/jpeg') return 'jpg';
    return mime.startsWith('image/') ? mime.slice(6) : 'bin';
}

function record(value: unknown): Record<string, unknown> {return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};}
function invalid(code: string): Error {return Object.assign(new Error(code), {code});}

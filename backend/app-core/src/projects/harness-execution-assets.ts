import type {EffectExecutionContext} from '@itookit/durable-kernel';
import {prepareHarnessInput, type HarnessAssetAttachment, type HarnessExecutionRequest, type HarnessInlineAttachment} from '@itookit/kernel-adapters/contracts';
import {sha256Hex} from '@itookit/llm-context/digest';
import {isSupportedTextContent} from '@itookit/driver-llm';
import {validateHarnessAttachments, type HarnessProfile} from '@itookit/nestos-node-driver/harness';
import type {TaskAssetReader} from '@itookit/tools/contracts';
import {executionError} from './harness-execution-journal';
import {validateExecutionInput} from './harness-execution-call-input';

const reasons: Record<string, string> = {
    HARNESS_ATTACHMENT_KIND_UNSUPPORTED: 'Selected Harness does not support this file kind; choose a compatible connection or remove it',
    HARNESS_ATTACHMENT_MEDIA_UNSUPPORTED: 'Selected file format requires an explicit conversion before this Harness can consume it',
    HARNESS_ATTACHMENT_TEXT_LIMIT: 'Native text attachment exceeds 64 KiB; reduce or explicitly split the input',
    HARNESS_ATTACHMENT_IMAGE_LIMIT: 'Native image attachment exceeds 256 KiB; prepare a smaller image',
    HARNESS_ASSET_READER_UNAVAILABLE: 'Asset reading is unavailable for this execution host',
    HARNESS_ASSET_INTEGRITY: 'Selected file bytes differ from the frozen reference; restore the original content or submit a new input',
    HARNESS_ASSET_STORAGE_DENIED: 'Asset storage access was denied; check the current file grants',
    HARNESS_ASSET_MISSING: 'Selected file is missing; restore it or submit a new input',
    ASSET_FLOW_MISMATCH: 'Selected Task file belongs to another invocation; explicitly import it before reuse',
    ASSET_SESSION_MISMATCH: 'Selected Task file belongs to another Session; explicitly import it before reuse',
    ASSET_INPUT_NOT_SELECTED: 'Asset was not selected in the consuming Task or Flow input',
    INPUT_ASSET_MISSING: 'Selected input asset is missing; restore it or submit a new input',
};

/** Read selected immutable content under the actual consuming Task, never a caller-provided owner. */
export async function prepareExecutionAttachments(request: HarnessExecutionRequest, context: EffectExecutionContext,
    profile: HarnessProfile, read?: TaskAssetReader): Promise<HarnessInlineAttachment[] | undefined> {
    validateExecutionInput({...request, attachments: []}, profile);
    const files = prepareHarnessInput({prompt: request.prompt, attachments: request.attachments}).attachments ?? [];
    if (files.length > 5) throw executionError('HARNESS_ATTACHMENT_COUNT_LIMIT');
    const prepared: HarnessInlineAttachment[] = [];
    for (const file of files) {
        context.abortSignal.throwIfAborted();
        prepared.push(file.kind === 'asset' ? await resolveAsset(file, context, profile, read) : structuredClone(file));
    }
    validateExecutionInput({...request, attachments: prepared}, profile);
    return prepared.length ? prepared : undefined;
}

async function resolveAsset(file: HarnessAssetAttachment, context: EffectExecutionContext,
    profile: HarnessProfile, read?: TaskAssetReader): Promise<HarnessInlineAttachment> {
    const mimeType = file.asset.mimeType.toLowerCase(), kind = nativeAssetKind(mimeType);
    if (!profile.capabilities.attachments?.includes(kind)) throw assetFailure('HARNESS_ATTACHMENT_KIND_UNSUPPORTED');
    validateName(file.name);
    if (file.asset.bytes > (kind === 'text' ? 64 : 256) * 1024)
        throw assetFailure(kind === 'text' ? 'HARNESS_ATTACHMENT_TEXT_LIMIT' : 'HARNESS_ATTACHMENT_IMAGE_LIMIT');
    if (!read) throw assetFailure('HARNESS_ASSET_READER_UNAVAILABLE');
    const bytes = await readAsset(file, context, read);
    if (bytes.byteLength !== file.asset.bytes || await sha256Hex(bytes) !== file.asset.sha256) throw assetFailure('HARNESS_ASSET_INTEGRITY');
    context.abortSignal.throwIfAborted();
    const content = kind === 'text' ? utf8(bytes) : `data:${mimeType};base64,${base64(bytes)}`;
    return {kind, name: file.name, mimeType, content};
}

function validateName(name: string): void {
    try {validateHarnessAttachments([{kind: 'text', name, content: ''}]);}
    catch (error) {throw executionError((error as {attachmentCode?: string})?.attachmentCode ?? 'HARNESS_ATTACHMENT_INVALID');}
}

function nativeAssetKind(mimeType: string): HarnessInlineAttachment['kind'] {
    if (['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) return 'image';
    if (isSupportedTextContent(mimeType)) return 'text';
    throw assetFailure('HARNESS_ATTACHMENT_MEDIA_UNSUPPORTED');
}

async function readAsset(file: HarnessAssetAttachment, context: EffectExecutionContext, read: TaskAssetReader): Promise<Uint8Array> {
    try {return await read(file.asset, {...context, operationId: context.effectId});}
    catch (error) {
        context.abortSignal.throwIfAborted();
        const failure = error as {code?: unknown; storageCode?: unknown}, code = failure?.code;
        if ([code, failure?.storageCode].some(value => value === 'EACCES' || value === 'EPERM')) throw assetFailure('HARNESS_ASSET_STORAGE_DENIED');
        if ([code, failure?.storageCode].includes('ENOENT')) throw assetFailure('HARNESS_ASSET_MISSING');
        const known = typeof code === 'string' && /^(?:INPUT_ASSET_|ASSET_|MEDIA_ASSET_)[A-Z_]{1,60}$/.test(code);
        throw assetFailure(known ? code : 'HARNESS_ASSET_READ_FAILED');
    }
}
function assetFailure(code: string): Error {
    return Object.assign(executionError(code), reasons[code] ? {message: reasons[code]} : {});
}
function utf8(bytes: Uint8Array): string {
    try {return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);}
    catch {throw executionError('HARNESS_ATTACHMENT_TEXT_ENCODING');}
}
function base64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
}

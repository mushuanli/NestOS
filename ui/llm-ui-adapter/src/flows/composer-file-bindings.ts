import {createModuleLogger, randomUUID, sha256Hex, t} from '@itookit/common';
import {fileBytes} from './input-assets';

interface Material {name?: string; asset: {bytes?: number; sha256?: string; mimeType?: string}}
const log = createModuleLogger('flow-file-bindings');

/** Composer attachments must be represented in the frozen arguments before they can be consumed. */
export async function validateComposerFiles(files: readonly File[], values: unknown, signal?: AbortSignal): Promise<void> {
    if (!files.length) return;
    const operationId = randomUUID(), started = Date.now(), materials = collectMaterials(values);
    try {
        for (const file of files) {
            signal?.throwIfAborted();
            const bytes = await fileBytes(file), sha256 = await sha256Hex(bytes);
            signal?.throwIfAborted();
            const match = materials.findIndex(part => part.name === file.name && part.asset.bytes === bytes.byteLength
                && part.asset.sha256 === sha256 && part.asset.mimeType === (file.type.toLowerCase() || 'application/octet-stream'));
            if (match < 0) throw Object.assign(new Error(t('flow.launch.filesUnbound')), {code: 'FLOW_INPUT_UNBOUND_ATTACHMENTS'});
            materials.splice(match, 1);
        }
        log.info('Flow composer files', {operationId, operation: 'flow.files.bind', stage: 'validation', result: 'success', fileCount: files.length, durationMs: Date.now() - started});
    } catch (error) {
        const code = (error as {code?: unknown})?.code;
        log.warn('Flow composer files', {operationId, operation: 'flow.files.bind', stage: 'validation', result: 'failure', fileCount: files.length,
            code: typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'FLOW_FILE_BINDING_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}

function collectMaterials(value: unknown, depth = 0): Material[] {
    if (!value || typeof value !== 'object') return [];
    if (depth > 64) throw Object.assign(new Error(t('flow.launch.filesInvalid')), {code: 'FLOW_INPUT_DEPTH'});
    const part = value as {type?: string; name?: string; source?: {type?: string; asset?: Material['asset']}};
    if (['image', 'file'].includes(part.type ?? '') && part.source?.type === 'asset' && part.source.asset)
        return [{name: part.name, asset: part.source.asset}];
    return Object.values(value).flatMap(child => collectMaterials(child, depth + 1));
}

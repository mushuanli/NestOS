import { sha256Hex } from '@itookit/llm-context';
import { taskStoragePath, type EffectExecutionContext } from '@itookit/durable-kernel';
import type { IFileSystem } from '@itookit/vfs-core';
import type { MediaGenerationResult } from '@itookit/driver-llm/contracts';
import type { LlmMediaEffectRequest, MediaResultStore, StoredMediaResult, MediaAssetReference } from './llm-media-effect';
type MediaStorageResolver = (context: EffectExecutionContext) => Promise<{ fs: IFileSystem; rootPath: string }>;
/** Publish a receipt only after every binary asset has been written and verified. */
export function createMediaResultStore(resolve: MediaStorageResolver): MediaResultStore {
    return {
        async get(request, context) {
            const { fs, rootPath } = await resolve(context), owner = ownerPath(context);
            const raw = await fs.meta.seq!.getEntry(`${rootPath}/${owner}`, receiptKey(context));
            if (!raw) return;
            const receipt = JSON.parse(raw) as { requestHash: string; result: StoredMediaResult };
            if (receipt.requestHash !== await requestHash(request)) throw new Error('Media receipt request mismatch');
            for (const asset of receipt.result.assets) await readMediaAsset(fs, rootPath, asset, context);
            return receipt.result;
        },
        async put(request, result, context) {
            if (result.model !== request.request.model || !result.assets.length) throw new Error('Invalid generated media result');
            const { fs, rootPath } = await resolve(context), owner = ownerPath(context), assets = [];
            for (const asset of result.assets) assets.push(await putAsset(fs, rootPath, owner, asset, context));
            const stored: StoredMediaResult = { model: result.model, assets, ...(result.usage ? { usage: result.usage } : {}) };
            context.abortSignal.throwIfAborted();
            await fs.meta.seq!.setEntry(`${rootPath}/${owner}`, receiptKey(context), JSON.stringify({ requestHash: await requestHash(request), result: stored }));
            return stored;
        },
    };
}
export async function readMediaAsset(fs: IFileSystem, root: string, asset: MediaAssetReference,
    identity: Pick<EffectExecutionContext, 'sessionId' | 'taskId'>): Promise<Uint8Array> {
    if (asset.sessionId !== identity.sessionId || asset.taskId !== identity.taskId || asset.owner !== ownerPath(identity)
        || !/^[a-f0-9]{64}\.bin$/.test(asset.name) || asset.name !== `${asset.sha256}.bin`) throw mediaAssetError('MEDIA_ASSET_IDENTITY', 'Invalid media asset identity');
    let body: unknown;
    try {body = await fs.meta.assets.getAsset(`${root}/${asset.owner}`, asset.name);}
    catch (error) {throw mediaAssetError('MEDIA_ASSET_READ_FAILED', 'Media asset storage could not be read', error);}
    if (!(body instanceof ArrayBuffer)) throw mediaAssetError('MEDIA_ASSET_MISSING', 'Media asset is missing or corrupt');
    const bytes = new Uint8Array(body);
    if (bytes.length !== asset.bytes || await sha256Hex(bytes) !== asset.sha256) throw mediaAssetError('MEDIA_ASSET_INTEGRITY', 'Media asset integrity mismatch');
    return bytes;
}
function mediaAssetError(code: string, message: string, cause?: unknown): Error {
    const storageCode = (cause as {code?: unknown})?.code;
    const safe = typeof storageCode === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'EIO', 'EROFS', 'EBUSY', 'ETIMEDOUT'].includes(storageCode);
    return Object.assign(new Error(message), {code, ...(safe ? {storageCode} : {})});
}
async function putAsset(fs: IFileSystem, root: string, owner: string, asset: MediaGenerationResult['assets'][number], context: EffectExecutionContext): Promise<MediaAssetReference> {
    context.abortSignal.throwIfAborted();
    const sha256 = await sha256Hex(asset.data), name = `${sha256}.bin`;
    const ref = { sessionId: context.sessionId, taskId: context.taskId, owner, name, mimeType: asset.mimeType, bytes: asset.data.length, sha256 };
    await fs.meta.assets.putAsset(`${root}/${owner}`, name, new Uint8Array(asset.data).buffer); await readMediaAsset(fs, root, ref, context); return ref;
}
function ownerPath(context: Pick<EffectExecutionContext, 'taskId'>): string { return taskStoragePath('/', context.taskId).slice(1); }
function receiptKey(context: EffectExecutionContext): string { return `media-result/${encodeURIComponent(context.effectId)}`; }
function requestHash(request: LlmMediaEffectRequest): Promise<string> {
    return sha256Hex(JSON.stringify({ connectionId: request.connectionId, snapshot: request.connectionSnapshot, request: request.request }));
}

import {sha256Hex} from '@itookit/llm-context/digest';
import type {InputAssetReference} from '@itookit/tools/contracts';
import type {IFileSystem} from '@itookit/vfs-core';

export const INPUT_ASSET_OWNER = '/var/lib/inputs.seq';
export interface InputAssetRecord extends InputAssetReference {version?: 2; name?: string}

export async function loadInputAssetRecord(fs: IFileSystem, ref: InputAssetReference): Promise<InputAssetRecord | undefined> {
    if (ref?.kind !== 'input' || !/^[a-f0-9-]{36}$/.test(ref.id)) throw inputAssetError('INPUT_ASSET_IDENTITY', 'Invalid input asset identity');
    validateContentIdentity(ref);
    if (!await fs.driver.exists(INPUT_ASSET_OWNER)) return;
    const raw = await fs.meta.seq!.getEntry(INPUT_ASSET_OWNER, ref.id);
    if (raw === null) return;
    let saved: InputAssetRecord;
    try {saved = JSON.parse(raw);}
    catch {throw inputAssetError('INPUT_ASSET_METADATA', 'Input asset metadata is invalid');}
    validateSavedRecord(saved, ref);
    return saved;
}
function validateSavedRecord(saved: InputAssetRecord, ref: InputAssetReference): void {
    if (!saved || saved.kind !== 'input' || saved.id !== ref.id || saved.version !== undefined && saved.version !== 2)
        throw inputAssetError('INPUT_ASSET_METADATA', 'Input asset metadata is invalid');
    if (saved.sha256 !== ref.sha256 || saved.bytes !== ref.bytes || saved.mimeType !== ref.mimeType)
        throw inputAssetError('INPUT_ASSET_INTEGRITY', 'Input asset metadata mismatch');
}
function validateContentIdentity(ref: InputAssetReference): void {
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256))
        throw inputAssetError('INPUT_ASSET_IDENTITY', 'Invalid input asset content identity');
    if (typeof ref.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(ref.mimeType))
        throw inputAssetError('INPUT_ASSET_IDENTITY', 'Invalid input asset MIME type');
}

export async function readInputAssetBody(fs: IFileSystem, record: InputAssetRecord): Promise<Uint8Array | undefined> {
    const name = record.version === 2 ? `${record.sha256}.bin` : `${record.id}.bin`;
    const body = await fs.meta.assets.getAsset(INPUT_ASSET_OWNER, name);
    if (body === null) return;
    if (!(body instanceof ArrayBuffer)) throw inputAssetError('INPUT_ASSET_INTEGRITY', 'Input asset content is invalid');
    const bytes = new Uint8Array(body);
    if (bytes.length !== record.bytes || await sha256Hex(bytes) !== record.sha256)
        throw inputAssetError('INPUT_ASSET_INTEGRITY', 'Input asset integrity mismatch');
    return bytes;
}

export async function readInputAsset(fs: IFileSystem, ref: InputAssetReference): Promise<Uint8Array> {
    const record = await loadInputAssetRecord(fs, ref);
    if (!record) throw inputAssetError('INPUT_ASSET_MISSING', 'Input asset is missing');
    const body = await readInputAssetBody(fs, record);
    if (!body) throw inputAssetError('INPUT_ASSET_MISSING', 'Input asset content is not ready; reconcile or retry its original upload');
    return body;
}

export async function ensureInputAssetStore(fs: IFileSystem): Promise<void> {
    if (await fs.driver.exists(INPUT_ASSET_OWNER)) return;
    try {await fs.driver.createFile({parentPath: '/var/lib', name: 'inputs.seq', type: 'seqfile', recursive: true});}
    catch (error) {if (!await fs.driver.exists(INPUT_ASSET_OWNER)) throw error;}
}
export function inputAssetError(code: string, message: string, cause?: unknown): Error {
    const remoteCode = (cause as {code?: unknown})?.code;
    return Object.assign(new Error(message, {cause}), {code,
        ...(typeof remoteCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(remoteCode) ? {remoteCode} : {})});
}

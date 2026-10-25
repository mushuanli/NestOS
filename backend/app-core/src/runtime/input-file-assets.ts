import {createModuleLogger} from '@itookit/common';
import {INPUT_ASSET_MAX_BYTES, type InputFileIdentity, type InputFileInspection, type InputFileUpload} from '@itookit/app-contracts';
import {sha256Hex} from '@itookit/llm-context/digest';
import type {InputAssetReference} from '@itookit/tools/contracts';
import type {IFileSystem} from '@itookit/vfs-core';
import {ensureInputAssetStore, inputAssetError, INPUT_ASSET_OWNER, readInputAssetBody, type InputAssetRecord} from './input-asset-store';

const log = createModuleLogger('input-file-assets');
const uploadIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export async function importInputFile(fs: IFileSystem, supplied: InputFileUpload): Promise<InputAssetReference> {
    const started = Date.now(); let stage = 'validation';
    let input = supplied;
    try {
        const reference = validateIdentity(input, true);
        if (!(input.data instanceof ArrayBuffer) || input.data.byteLength !== input.bytes)
            throw inputAssetError('INPUT_ASSET_CONTENT_MISMATCH', 'File bytes differ from the upload identity');
        input = {...input, data: input.data.slice(0)};
        if (await sha256Hex(input.data) !== input.sha256)
            throw inputAssetError('INPUT_ASSET_CONTENT_MISMATCH', 'File bytes differ from the upload identity');
        stage = 'reservation'; await ensureInputAssetStore(fs); const record = await reserve(fs, input, reference);
        stage = 'content'; await ensureContent(fs, record, input.data);
        report(input, stage, started); return reference;
    } catch (error) {report(input, stage, started, error); throw error;}
}

export async function inspectInputFile(fs: IFileSystem, input: InputFileIdentity): Promise<InputFileInspection> {
    const started = Date.now();
    try {
        const reference = validateIdentity(input);
        input = {...input};
        if (!await fs.driver.exists(INPUT_ASSET_OWNER)) {report(input, 'inspection', started, undefined, 'missing'); return {state: 'missing'};}
        const record = await readReservation(fs, input, reference);
        if (!record) {report(input, 'inspection', started, undefined, 'missing'); return {state: 'missing'};}
        const body = await readInputAssetBody(fs, record); report(input, 'inspection', started, undefined, body ? 'ready' : 'preparing');
        return {state: body ? 'ready' : 'preparing', reference};
    } catch (error) {report(input, 'inspection', started, error); throw error;}
}

function validateIdentity(value: unknown, upload = false): InputAssetReference {
    if (!value || typeof value !== 'object') throw inputAssetError('INPUT_ASSET_IDENTITY', 'File upload identity is required');
    const input = value as InputFileIdentity;
    const fields = ['uploadId', 'name', 'mimeType', 'bytes', 'sha256', ...(upload ? ['data'] : [])];
    if (Object.keys(value).some(key => !fields.includes(key))) throw inputAssetError('INPUT_ASSET_FORMAT', 'Unknown file upload field');
    if (typeof input.uploadId !== 'string' || !uploadIdPattern.test(input.uploadId))
        throw inputAssetError('INPUT_ASSET_IDENTITY', 'File upload requires a stable UUID v4');
    validateName(input.name);
    validateMetadata(input);
    return {kind: 'input', id: input.uploadId, mimeType: input.mimeType, bytes: input.bytes, sha256: input.sha256};
}
function validateMetadata(input: InputFileIdentity): void {
    if (typeof input.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(input.mimeType)) throw inputAssetError('INPUT_ASSET_FORMAT', 'File MIME type is invalid');
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > INPUT_ASSET_MAX_BYTES)
        throw inputAssetError('INPUT_ASSET_TOO_LARGE', 'File exceeds the upload limit (20 MiB)');
    if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) throw inputAssetError('INPUT_ASSET_IDENTITY', 'File content digest is invalid');
}
function validateName(name: unknown): void {
    if (typeof name !== 'string' || !name || /[\x00-\x1f\x7f-\x9f/\\]/.test(name)) throw inputAssetError('INPUT_ASSET_NAME', 'File name must not contain paths or control characters');
    const bytes = new TextEncoder().encode(name);
    if (bytes.length > 1024 || new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes) !== name)
        throw inputAssetError('INPUT_ASSET_NAME', 'File name must be valid Unicode within 1024 UTF-8 bytes');
}

async function reserve(fs: IFileSystem, input: InputFileIdentity, reference: InputAssetReference): Promise<InputAssetRecord> {
    if (!fs.meta.seq?.transaction) throw inputAssetError('INPUT_ASSET_CAPABILITY', 'File uploads require transactional input storage');
    const record: InputAssetRecord = {...reference, version: 2, name: input.name};
    try {
        await fs.meta.seq.transaction(async tx => {
            const saved = await tx.getEntry(INPUT_ASSET_OWNER, reference.id);
            if (saved !== null) assertReservation(JSON.parse(saved), input, reference);
            else await tx.setEntry(INPUT_ASSET_OWNER, reference.id, JSON.stringify(record));
        });
    } catch (error) {
        if ((error as {code?: string})?.code === 'INPUT_ASSET_CONFLICT') throw error;
        const saved = await readReservation(fs, input, reference);
        if (!saved) throw inputAssetError('INPUT_ASSET_WRITE_UNCONFIRMED', 'Upload reservation is unconfirmed; reconcile its original identity', error);
        assertReservation(saved, input, reference);
    }
    return record;
}
async function readReservation(fs: IFileSystem, input: InputFileIdentity, reference: InputAssetReference): Promise<InputAssetRecord | undefined> {
    const raw = await fs.meta.seq!.getEntry(INPUT_ASSET_OWNER, reference.id);
    if (raw === null) return;
    let record: InputAssetRecord;
    try {record = JSON.parse(raw);}
    catch {throw inputAssetError('INPUT_ASSET_METADATA', 'Input asset metadata is invalid');}
    assertReservation(record, input, reference); return record;
}
function assertReservation(saved: InputAssetRecord, input: InputFileIdentity, reference: InputAssetReference): void {
    if (saved?.kind !== 'input' || saved.version !== 2 || saved.id !== reference.id || saved.name !== input.name || saved.mimeType !== reference.mimeType
        || saved.bytes !== reference.bytes || saved.sha256 !== reference.sha256)
        throw inputAssetError('INPUT_ASSET_CONFLICT', 'Upload identity was used for different file metadata or content');
}

async function ensureContent(fs: IFileSystem, record: InputAssetRecord, data: ArrayBuffer): Promise<void> {
    if (await readInputAssetBody(fs, record)) return;
    let failure: unknown;
    try {await fs.meta.assets.putAsset(INPUT_ASSET_OWNER, `${record.sha256}.bin`, data.slice(0));}
    catch (error) {failure = error;}
    if (!await readInputAssetBody(fs, record)) throw inputAssetError('INPUT_ASSET_WRITE_UNCONFIRMED', 'File content persistence is unconfirmed; reconcile its original upload', failure);
}
function report(input: InputFileIdentity, stage: string, started: number, error?: unknown, result?: InputFileInspection['state']): void {
    const code = (error as {code?: unknown})?.code;
    const metadata = {operation: stage === 'inspection' ? 'input-asset.inspect' : 'input-asset.upload', operationId: safeUploadId(input?.uploadId),
        stage, result: error ? 'failure' : result ?? 'success', bytes: Number.isSafeInteger(input?.bytes) ? input.bytes : undefined,
        code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : error ? 'INPUT_ASSET_ERROR' : undefined, durationMs: Date.now() - started};
    if (error) log.warn('Input asset', metadata); else log.info('Input asset', metadata);
}
function safeUploadId(value: unknown): string | undefined {return typeof value === 'string' && uploadIdPattern.test(value) ? value : undefined;}

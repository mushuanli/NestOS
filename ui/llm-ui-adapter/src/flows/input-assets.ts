import {createModuleLogger, randomUUID, sha256Hex} from '@itookit/common';
import {InputAssetCommand, INPUT_ASSET_MAX_BYTES, type InputFileIdentity, type InputFileInspection} from '@itookit/app-contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import type {JsonValue} from '@itookit/llm-flow/contracts';
import type {FlowImageAssetPort} from '../components/FlowImageFields';
import type {FlowFileAssetPort} from '../components/FlowFileAssetPort';
import {observePromise} from '../utils/observe-promise';

type Port = FlowImageAssetPort & FlowFileAssetPort;
interface Upload {id: string; identity?: InputFileIdentity; pending?: Promise<JsonValue>; stage: string}
const ports = new WeakMap<ICommandBus, Port>(), log = createModuleLogger('flow-input-assets');

export function flowInputAssets(commands: ICommandBus): Port {
    let port = ports.get(commands);
    if (port) return port;
    const uploads = new WeakMap<File, Upload>();
    port = {import: url => commands.execute(InputAssetCommand.Import, {url}), read: reference => commands.execute(InputAssetCommand.Read, {reference}),
        importFile: (file, signal) => importFile(commands, uploads, file, signal)};
    ports.set(commands, port); return port;
}

async function importFile(commands: ICommandBus, uploads: WeakMap<File, Upload>, file: File, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted();
    let upload = uploads.get(file);
    if (!upload) {upload = {id: randomUUID(), stage: 'validation'}; uploads.set(file, upload);}
    if (!upload.pending) {
        const pending = prepareFile(commands, file, upload); upload.pending = pending;
        const clear = () => {if (upload!.pending === pending) upload!.pending = undefined;};
        void pending.then(clear, clear);
    }
    const reference = await observePromise(upload.pending, signal); return structuredClone(reference);
}

async function prepareFile(commands: ICommandBus, file: File, upload: Upload): Promise<JsonValue> {
    const started = Date.now();
    try {
        if (file.size > INPUT_ASSET_MAX_BYTES) throw failure('INPUT_ASSET_TOO_LARGE', 'File exceeds 20 MiB');
        upload.stage = 'file-read'; const data = await fileBytes(file);
        upload.stage = 'digest'; const identity: InputFileIdentity = {uploadId: upload.id, name: file.name,
            mimeType: file.type.toLowerCase() || 'application/octet-stream', bytes: data.byteLength, sha256: await sha256Hex(data)};
        if (upload.identity && JSON.stringify(upload.identity) !== JSON.stringify(identity)) throw failure('INPUT_ASSET_CONTENT_MISMATCH', 'File changed under its upload identity');
        upload.identity = identity; upload.stage = 'inspection';
        const prior = await inspect(commands, identity);
        const reference = prior ?? await sendFile(commands, upload, identity, data);
        report(upload, started); return reference;
    } catch (error) {report(upload, started, error); throw error;}
}

async function sendFile(commands: ICommandBus, upload: Upload, identity: InputFileIdentity, data: ArrayBuffer): Promise<JsonValue> {
    upload.stage = 'upload';
    try {return validateReference(await commands.execute(InputAssetCommand.ImportFile, {...identity, data}), identity);}
    catch (error) {
        upload.stage = 'reconciliation'; const confirmed = await inspect(commands, identity).catch(() => undefined);
        if (confirmed) return confirmed;
        throw error;
    }
}
async function inspect(commands: ICommandBus, identity: InputFileIdentity): Promise<JsonValue | undefined> {
    const state = await commands.execute<InputFileInspection>(InputAssetCommand.Inspect, identity);
    if (!state || !['missing', 'preparing', 'ready'].includes(state.state)) throw failure('INPUT_ASSET_RECEIPT_INVALID', 'Invalid upload inspection');
    if (state.state !== 'missing') validateReference(state.reference, identity);
    return state.state === 'ready' ? validateReference(state.reference, identity) : undefined;
}
function validateReference(value: unknown, identity: InputFileIdentity): JsonValue {
    const ref = value as Record<string, unknown> | undefined;
    if (!ref || ref.kind !== 'input' || ref.id !== identity.uploadId || ref.sha256 !== identity.sha256 || ref.bytes !== identity.bytes || ref.mimeType !== identity.mimeType)
        throw failure('INPUT_ASSET_RECEIPT_INVALID', 'Upload receipt differs from the frozen file identity');
    return {kind: 'input', id: identity.uploadId, mimeType: identity.mimeType, bytes: identity.bytes, sha256: identity.sha256};
}

export async function fileBytes(file: File): Promise<ArrayBuffer> {
    try {
        if (file.arrayBuffer) return await file.arrayBuffer();
        return await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(failure('INPUT_ASSET_CLIENT_READ_FAILED', 'Cannot read the selected file'));
            reader.onerror = () => reject(failure('INPUT_ASSET_CLIENT_READ_FAILED', 'Cannot read the selected file')); reader.readAsArrayBuffer(file);
        });
    } catch {throw failure('INPUT_ASSET_CLIENT_READ_FAILED', 'Cannot read the selected file');}
}
function report(upload: Upload, started: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    const metadata = {operation: 'flow.asset.prepare', operationId: upload.id, stage: upload.stage, result: error ? 'failure' : 'ready',
        bytes: upload.identity?.bytes, code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : error ? 'INPUT_ASSET_UPLOAD_FAILED' : undefined, durationMs: Date.now() - started};
    if (error) log.warn('Flow input file', metadata); else log.info('Flow input file', metadata);
}
function failure(code: string, message: string): Error {return Object.assign(new Error(message), {code});}

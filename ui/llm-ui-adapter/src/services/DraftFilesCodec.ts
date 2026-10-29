import {createModuleLogger, sha256Hex, t} from '@itookit/common';
import {validateSpec, type ImageSpec} from '@itookit/image-parser';
import {knownImageFileState, setImageFileState} from '../components/input/image-file-state';
import {draftFileId, restoreDraftFileId, validDraftToken} from '../domain/draft-file-identity';
import {fileBytes} from '../utils/file-bytes';

export interface DraftFilePort {put(data: ArrayBuffer): Promise<string>; read(id: string): Promise<ArrayBuffer>}
export interface DraftFileBase {
    id: string; name: string; type: string; lastModified: number;
    fileId?: string; sha256?: string; bytes?: number;
}
export interface DraftFileRecord extends DraftFileBase {
    image?: {id: string; revision: number; original: DraftFileBase; spec: ImageSpec; resizeKey?: string};
}
const log = createModuleLogger('draft-files');

/** Share immutable binary staging between initial project drafts and existing Session drafts. */
export class DraftFilesCodec {
    private readonly encoded = new WeakMap<File, Promise<DraftFileBase>>();
    constructor(private readonly port?: DraftFilePort) {}
    encode(files: readonly File[]): Promise<DraftFileRecord[]> {return Promise.all(files.map(file => this.encodeFile(file)));}
    async decode(value: unknown): Promise<File[]> {
        const records = readDraftFiles(value);
        return Promise.all(records.map(async stored => {
            const file = await this.decodeRaw(stored);
            if (stored.image) setImageFileState(file, {...stored.image, original: await this.decodeRaw(stored.image.original)});
            return file;
        }));
    }
    private async encodeFile(file: File): Promise<DraftFileRecord> {
        const raw = knownImageFileState(file), image = raw && {...raw, spec: structuredClone(raw.spec)};
        const stored = await this.encodeRaw(file);
        return image ? {...stored, image: {id: image.id, revision: image.revision, spec: image.spec,
            resizeKey: image.resizeKey, original: await this.encodeRaw(image.original)}} : stored;
    }
    private encodeRaw(file: File): Promise<DraftFileBase> {
        let pending = this.encoded.get(file);
        if (pending) return pending;
        const fileId = draftFileId(file), started = Date.now(); let stage = 'file-read';
        pending = fileBytes(file).then(async value => {
            stage = 'digest'; const data = value.slice(0), sha256 = await sha256Hex(data); stage = 'persist';
            return {id: await this.storage().put(data.slice(0)), fileId,
                name: file.name, type: file.type, lastModified: file.lastModified, bytes: data.byteLength, sha256};
        }).then(record => {report('encode', fileId, stage, started, record.bytes); return record;},
            error => {report('encode', fileId, stage, started, file.size, error); throw error;});
        this.encoded.set(file, pending); void pending.catch(() => this.encoded.delete(file)); return pending;
    }
    private async decodeRaw(stored: DraftFileBase): Promise<File> {
        const started = Date.now(); let stage = 'asset-read';
        try {
            const received = await this.storage().read(stored.id); stage = 'integrity';
            let data: ArrayBuffer;
            try {data = ArrayBuffer.prototype.slice.call(received, 0);}
            catch {throw invalid('DRAFT_FILE_INTEGRITY');}
            const sha256 = await sha256Hex(data);
            if (stored.sha256 !== undefined && (sha256 !== stored.sha256 || data.byteLength !== stored.bytes)) throw invalid('DRAFT_FILE_INTEGRITY');
            const file = new File([data], stored.name, stored), fileId = stored.fileId ?? (validDraftToken(stored.id) ? stored.id : draftFileId(file));
            restoreDraftFileId(file, fileId);
            this.encoded.set(file, Promise.resolve({...stored, fileId, bytes: data.byteLength, sha256}));
            report('decode', fileId, stage, started, data.byteLength); return file;
        } catch (cause) {
            const error = (cause as {code?: string})?.code === 'ENOENT' ? invalid('DRAFT_FILE_MISSING') : cause;
            report('decode', stored.fileId, stage, started, stored.bytes, error); throw error;
        }
    }
    private storage(): DraftFilePort {
        if (!this.port) throw invalid('DRAFT_FILE_STORAGE_UNAVAILABLE');
        return this.port;
    }
}

/** Validate the whole reference envelope before performing any asset reads. */
export function readDraftFiles(value: unknown): DraftFileRecord[] {
    if (!Array.isArray(value) || !value.every(validRecord)) throw invalid('DRAFT_FILE_METADATA_INVALID');
    return structuredClone(value);
}
function validRecord(value: unknown): value is DraftFileRecord {
    if (!validBase(value)) return false;
    const image = (value as DraftFileRecord).image;
    if (image === undefined) return true;
    if (!image || typeof image.id !== 'string' || !Number.isSafeInteger(image.revision) || image.revision < 0 || !validBase(image.original)) return false;
    try {validateSpec(image.spec); return true;} catch {return false;}
}
function validBase(value: unknown): value is DraftFileBase {
    if (!value || typeof value !== 'object') return false;
    const file = value as DraftFileBase;
    return typeof file.id === 'string' && !!file.id && file.id.length <= 1024 && typeof file.name === 'string'
        && typeof file.type === 'string' && Number.isSafeInteger(file.lastModified)
        && (file.fileId === undefined || validDraftToken(file.fileId))
        && (file.sha256 === undefined && file.bytes === undefined || typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)
            && Number.isSafeInteger(file.bytes) && file.bytes! >= 0);
}
function invalid(code: string): Error {
    const key = code === 'DRAFT_FILE_MISSING' ? 'chatInput.attachments.draftMissing'
        : code === 'DRAFT_FILE_STORAGE_UNAVAILABLE' ? 'chatInput.attachments.unavailable' : 'chatInput.attachments.draftInvalid';
    return Object.assign(new Error(t(key)), {code});
}
function report(operation: string, operationId: string | undefined, stage: string, started: number, bytes?: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    const metadata = {operation: `draft.files.${operation}`, operationId, stage, result: error ? 'failure' : 'success', bytes,
        code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : error ? 'DRAFT_FILE_FAILURE' : undefined,
        durationMs: Date.now() - started};
    try {if (error) log.warn('Draft attachment', metadata); else log.debug('Draft attachment', metadata);}
    catch { /* Diagnostics cannot rewrite a persisted draft or its original failure. */ }
}

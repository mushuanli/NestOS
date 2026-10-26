import {KernelError, KernelErrorCode, type Kernel, type SessionHandle, type JsonValue} from '@itookit/durable-kernel';
import type {ISessionRepository} from '../persistence/types';
import type {CreateChildInput, ChildCreationReceipt, ContentTransfer, TransferReference} from '../contracts/content-transfer';
import {sessionDirectoryStorage} from '../persistence/session-directory-storage';
import {createSessionHost, type SessionHostPorts} from '../utils/host-ports';
import {ulid} from '../persistence/ulid';
type Phase = 'validate' | 'pending-owner' | 'parent' | 'reservation' | 'metadata' | 'execution' | 'completion' | 'lookup';
type Progress = (phase: Phase) => void;
interface ChildIntent {input: CreateChildInput; sessionId: string; initialContext?: ContentTransfer; created?: true}
interface Options {
    kernel: Kernel; repository: Pick<ISessionRepository, 'getManifest' | 'ensureSession'>; hostPorts?: SessionHostPorts;
    writable(sessionId: string): Promise<void>;
    readTransfer(reference: TransferReference, destination: string): Promise<ContentTransfer>;
    canWrite?(sessionId: string): Promise<boolean>;
    prepareExecution?(sessionId: string): Promise<void>;
}
/** Child identity and original completion stay in the existing parent intent, never a second execution store. */
export class ChildSessionCreation {
    private readonly host;
    private readonly children = new Map<string, Promise<{sessionId: string}>>();
    constructor(private readonly options: Options) {this.host = createSessionHost(options.hostPorts);}
    create(input: CreateChildInput): Promise<{sessionId: string}> {
        return this.observe('create', input, (captured, progress) => this.createCaptured(captured, progress));
    }
    inspect(input: CreateChildInput): Promise<ChildCreationReceipt> {
        return this.observe('receipt', input, (captured, progress) => this.readChildReceipt(captured, progress));
    }
    private createCaptured(input: CreateChildInput, progress: Progress): Promise<{sessionId: string}> {
        const key = `${input.sessionId}/${input.requestId}`, pending = this.children.get(key);
        if (pending) {progress('pending-owner'); return pending.then(() => this.admitChild(input, progress));}
        const operation = this.admitChild(input, progress); this.children.set(key, operation);
        return operation.finally(() => this.children.delete(key));
    }
    private async readChildReceipt(input: CreateChildInput, progress: Progress): Promise<ChildCreationReceipt> {
        progress('parent'); await this.options.repository.getManifest(input.sessionId);
        progress('lookup'); const base = {parentSessionId: input.sessionId, requestId: input.requestId};
        let stored;
        try {stored = await (await this.options.kernel.inspectSession(input.sessionId)).getShared(`content.child.${input.requestId}`);}
        catch (error) {if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return {...base, status: 'unknown'}; throw error;}
        if (!stored) return {...base, status: 'unknown'};
        const intent = this.matchChildIntent(stored.value as unknown as ChildIntent, input);
        return {...base, status: intent.created ? 'created' : 'reserved', sessionId: intent.sessionId};
    }

    private async admitChild(input: CreateChildInput, progress: Progress): Promise<{ sessionId: string }> {
        input = structuredClone(input);
        if (!validChildInput(input)) throw childError('CONTENT_CHILD_ARGUMENTS_INVALID');
        progress('parent'); await this.options.writable(input.sessionId);
        const parent = await this.options.repository.getManifest(input.sessionId);
        const session = await this.options.kernel.openSession(input.sessionId), key = `content.child.${input.requestId}`;
        progress('reservation'); const intent = await this.childIntent(session, key, input);
        if (intent.created) return {sessionId: intent.sessionId};
        progress('metadata'); await this.options.repository.ensureSession(intent.sessionId, input.title.trim(), parent.origin, parent.folder, parent.id,
            { initialContext: intent.initialContext });
        progress('execution'); await this.prepareChildExecution(intent.sessionId);
        progress('completion'); await this.commitChildCreation(session, key, input);
        return { sessionId: intent.sessionId };
    }

    private async childIntent(session: SessionHandle, key: string, input: CreateChildInput): Promise<ChildIntent> {
        const stored = (await session.getShared(key))?.value as unknown as ChildIntent | undefined;
        if (stored) return this.matchChildIntent(stored, input);
        const intent: ChildIntent = {input, sessionId: `node-${ulid()}`,
            ...(input.transfer ? {initialContext: await this.options.readTransfer(input.transfer, input.sessionId)} : {})};
        try {await session.setShared(key, json(intent), {expectedVersion: null}); return intent;}
        catch (error) {
            // A concurrent owner or a lost reply may already have persisted this request.
            const observed = (await session.getShared(key))?.value as unknown as ChildIntent | undefined;
            if (!observed) throw error;
            return this.matchChildIntent(observed, input);
        }
    }

    private matchChildIntent(intent: ChildIntent, input: CreateChildInput): ChildIntent {
        if (!intent || typeof intent !== 'object' || !validChildInput(intent.input) || typeof intent.sessionId !== 'string'
            || !/^[\w:-]{1,256}$/.test(intent.sessionId) || intent.created !== undefined && intent.created !== true) throw childError('CONTENT_CHILD_RECORD_INVALID');
        const saved = intent.input;
        if (saved.sessionId !== input.sessionId || saved.requestId !== input.requestId || saved.title !== input.title
            || saved.transfer?.sessionId !== input.transfer?.sessionId || saved.transfer?.id !== input.transfer?.id)
            throw childError('CONTENT_CHILD_REQUEST_CONFLICT');
        return intent;
    }

    private async commitChildCreation(session: SessionHandle, key: string, input: CreateChildInput): Promise<void> {
        const stored = await session.getShared(key);
        if (!stored) throw childError('CONTENT_CHILD_RECORD_INVALID');
        const intent = this.matchChildIntent(stored.value as unknown as ChildIntent, input);
        if (intent.created) return;
        try {await session.setShared(key, json({...intent, created: true}), {expectedVersion: stored.version});}
        catch (error) {
            const observed = await session.getShared(key);
            if (!observed || !this.matchChildIntent(observed.value as unknown as ChildIntent, input).created) throw error;
        }
    }

    private async prepareChildExecution(id: string): Promise<void> {
        await this.options.prepareExecution?.(id);
        if (this.options.canWrite && !await this.options.canWrite(id)) throw new Error('CONTENT_SESSION_READ_ONLY');
        const storage = sessionDirectoryStorage(id);
        try { await this.options.kernel.openSession(id, storage); }
        catch (error) {
            if (!(error instanceof KernelError) || error.code !== KernelErrorCode.SESSION_NOT_FOUND) throw error;
            await this.options.kernel.createSession({ id, storage });
        }
    }

    private async observe<T>(stage: 'create' | 'receipt', supplied: CreateChildInput, operation: (input: CreateChildInput, progress: Progress) => Promise<T>): Promise<T> {
        const started = Date.now(); let outcome = 'failure', code: string | undefined, phase: Phase = 'validate';
        try {
            const input = structuredClone(supplied);
            if (!validChildInput(input)) throw childError('CONTENT_CHILD_ARGUMENTS_INVALID');
            const result = await operation(input, next => {phase = next;}); outcome = (result as {status?: string}).status ?? 'created'; return result;
        } catch (error) {
            const failure = error as {code?: unknown; message?: unknown};
            const value = failure?.code ?? (typeof failure?.message === 'string' && /^CONTENT_[A-Z_]+$/.test(failure.message) ? failure.message : undefined);
            code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'CONTENT_CHILD_OPERATION_FAILED'; throw error;
        } finally {
            const safe = (value: unknown) => typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;
            const detail = {operation: `content.child.${stage}`, operationId: safe(supplied?.requestId), sessionId: safe(supplied?.sessionId),
                stage: phase, outcome, code, durationMs: Date.now() - started};
            try {if (code) this.host.logger.error('Child creation', detail); else this.host.logger.info('Child creation', detail);}
            catch { /* Diagnostics never replace the original creation fact or failure. */ }
        }
    }
}
function json(value: unknown): JsonValue {return JSON.parse(JSON.stringify(value));}
function validChildInput(input: CreateChildInput): boolean {
    const reference = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 4096;
    return !!input && typeof input === 'object' && Object.keys(input).every(key => ['sessionId', 'requestId', 'title', 'transfer'].includes(key))
        && reference(input.sessionId) && typeof input.requestId === 'string' && /^[\w-]{1,128}$/.test(input.requestId) && reference(input.title)
        && (input.transfer === undefined || !!input.transfer && typeof input.transfer === 'object'
            && Object.keys(input.transfer).every(key => ['sessionId', 'id'].includes(key)) && reference(input.transfer.sessionId) && reference(input.transfer.id));
}

function childError(code: string): Error {return Object.assign(new Error(code), {code});}

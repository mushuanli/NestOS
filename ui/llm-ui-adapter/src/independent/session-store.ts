import {StoredChatImages} from './stored-chat-images';
import type {ImageAssetMetadata} from './image-editing';
import {createOperationLedger, type AttachmentRef, type ComposerDraft, type OperationLedger} from '@itookit/llm-ui';
import type {ConversationUIState, ISessionRepository} from '@itookit/llm-session/contracts';
import {createModuleLogger, randomUUID} from '@itookit/common';
import {AssetService} from '../services/AssetService';
import {DraftPersistence, readBranchDraft, type BranchDraft} from '../services/DraftPersistence';
import {persistOperations} from '../services/OperationPersistence';
import {readDraftFiles} from '../services/DraftFilesCodec';
import {readInputDraft} from '../domain/input-draft';
import {isTargetRef} from '@itookit/llm-flow/contracts';
import {validDraftToken} from '../domain/draft-file-identity';
import {readInputContextDraft} from '../domain/context-draft';
import {canonicalJson} from '../utils/canonical-json';

type StoredBranch = BranchDraft & {inputImageMetadata?: Record<string, ImageAssetMetadata>; inputView?: {version: 1; draft: ComposerDraft}};
/** Keep the existing branch draft and CAS conflict boundary while replacing its renderer. */
export class SessionChatStore {
    readonly images: StoredChatImages;
    private readonly persistence: DraftPersistence;
    private tail: Promise<void> = Promise.resolve();
    private raw?: ConversationUIState;
    private saved!: ComposerDraft;
    private suspended = false;
    private constructor(private repository: ISessionRepository, readonly sessionId: string, readonly branch: string, readonly assets: AssetService) {
        this.persistence = new DraftPersistence(repository);
        this.images = new StoredChatImages({upload: (file, options) => this.upload(file, options), read: async (ref, {signal}) => {
            signal.throwIfAborted(); const bytes = await assets.draftFiles().read(ref.id); signal.throwIfAborted(); return new Blob([bytes], {type: ref.mimeType});
        }});
    }
    static async open(repository: ISessionRepository, sessionId: string, branch: string, assets: AssetService, initial?: {uiState?: ConversationUIState}): Promise<SessionChatStore> {
        const store = new SessionChatStore(repository, sessionId, branch, assets);
        const operationId = randomUUID(), started = Date.now(); let stage = 'read';
        try {
            store.raw = initial ? structuredClone(initial.uiState) : await repository.getUIState(sessionId) ?? undefined; stage = 'restore';
            store.persistence.observe(sessionId, branch, store.raw);
            const stored = readBranchDraft(store.raw, branch) as StoredBranch | undefined;
            store.saved = restore(stored); store.images.restore(stored?.inputImageMetadata, readDraftFiles(stored?.inputFiles ?? []));
            reportRestore(operationId, sessionId, branch, stage, started); return store;
        } catch (error) {
            const raw = (error as {code?: unknown})?.code;
            const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw
                : stage === 'read' ? 'DRAFT_STORE_READ_FAILED' : 'DRAFT_FORMAT_INVALID';
            reportRestore(operationId, sessionId, branch, stage, started, code);
            throw Object.assign(new Error(error instanceof Error ? error.message : String(error), {cause: error}), {code});
        }
    }
    get agentId(): string | undefined {return readBranchDraft(this.raw, this.branch)?.inputAgentId;}
    get draft(): ComposerDraft {return structuredClone(this.saved);}
    ledger(): OperationLedger {
        return createOperationLedger({initial: this.raw?.operationRecords as unknown as import('@itookit/llm-ui').OperationRecord[] | undefined,
            save: records => persistOperations(this.repository, this.sessionId, records)});
    }
    save(draft: ComposerDraft): Promise<void> {
        const captured = structuredClone(draft);
        const next = this.tail.catch(() => {}).then(async () => {
            if (this.suspended) return;
            if (captured.revision < this.saved.revision) return;
            const old = readBranchDraft(this.raw, this.branch) as StoredBranch | undefined;
            const branch: StoredBranch = {...old, inputText: captured.text, inputToken: validDraftToken(captured.scopeId) ? captured.scopeId : old?.inputToken ?? randomUUID(),
                inputTarget: isTargetRef(captured.target) ? captured.target : undefined,
                inputArguments: captured.input ? JSON.parse(JSON.stringify(captured.input)) : undefined,
                inputContext: captured.context?.value == null ? undefined : structuredClone(captured.context.value),
                inputImageMetadata: this.images.snapshot(),
                inputFiles: JSON.parse(JSON.stringify(this.images.records(captured.attachments.map(item => ({id: item.file.id, name: item.file.name, type: item.file.mimeType ?? '', lastModified: 0, fileId: item.id}))))),
                inputView: {version: 1, draft: captured}};
            const patch = {branchDrafts: {[this.branch]: branch}};
            await this.persistence.save(this.sessionId, this.branch, patch);
            this.raw = {...this.raw, branchDrafts: {...this.raw?.branchDrafts, ...patch.branchDrafts}}; this.saved = captured;
        });
        this.tail = next; return next;
    }
    dirty(draft: ComposerDraft): boolean {return JSON.stringify(draft) !== JSON.stringify(this.saved);}
    suspend(): void {this.suspended = true;}
    async upload(file: File, {signal}: {signal: AbortSignal}): Promise<AttachmentRef> {
        const operationId = randomUUID(), started = Date.now(); let stage = 'file-read';
        try {
            signal.throwIfAborted(); const bytes = await file.arrayBuffer(); signal.throwIfAborted(); stage = 'asset-write';
            const id = await this.assets.draftFiles().put(bytes); signal.throwIfAborted();
            reportUpload(operationId, stage, started, file.size); return {id, name: file.name, mimeType: file.type};
        } catch (error) {reportUpload(operationId, stage, started, file.size, error); throw error;}
    }
    async files(refs: readonly AttachmentRef[], signal?: AbortSignal): Promise<File[]> {
        const files: File[] = [];
        for (const ref of refs) {signal?.throwIfAborted(); const bytes = await this.assets.draftFiles().read(ref.id);
            signal?.throwIfAborted(); files.push(new File([bytes], ref.name, {type: ref.mimeType}));}
        return files;
    }
}
function reportRestore(operationId: string, sessionId: string, branch: string, stage: string, started: number, code?: string): void {
    try {
        const data = {operationId, sessionId, branch, stage, result: code ? 'failure' : 'success', durationMs: Date.now() - started, code};
        const log = createModuleLogger('session-chat-storage');
        if (code) log.warn('chat.draft.restore', data); else log.debug('chat.draft.restore', data);
    } catch { /* Diagnostics cannot change draft restoration. */ }
}
function restore(stored?: StoredBranch): ComposerDraft {
    const legacy = restoreLegacy(stored);
    if (stored?.inputView) {
        const value = stored.inputView;
        if (value.version !== 1 || typeof value.draft?.text !== 'string' || !Array.isArray(value.draft.attachments)
            || !Number.isSafeInteger(value.draft.revision) || !Number.isSafeInteger(value.draft.textRevision)) throw new Error('Invalid stored ChatView draft');
        const tokenChanged = validDraftToken(value.draft.scopeId) && stored.inputToken && stored.inputToken !== value.draft.scopeId;
        if (tokenChanged || !sameLegacyDraft(value.draft, legacy)) return {...legacy, revision: value.draft.revision + 1, textRevision: value.draft.textRevision + 1};
        return {...structuredClone(value.draft), scopeId: value.draft.scopeId ?? legacy.scopeId};
    }
    return legacy;
}
function restoreLegacy(stored?: StoredBranch): ComposerDraft {
    const files = readDraftFiles(stored?.inputFiles ?? []);
    const context = readInputContextDraft(stored?.inputContext);
    return {revision: 0, textRevision: 0, scopeId: stored?.inputToken ?? randomUUID(), text: stored?.inputText ?? '', target: stored?.inputTarget,
        input: readInputDraft(stored?.inputArguments),
        ...(context ? {context: {revision: context.revision, value: JSON.parse(JSON.stringify(context))}} : {}),
        attachments: files.map(file => ({id: file.fileId ?? randomUUID(), revision: 0, file: {id: file.id, name: file.name, mimeType: file.type}}))};
}
function sameLegacyDraft(view: ComposerDraft, legacy: ComposerDraft): boolean {
    const summarize = (draft: ComposerDraft) => ({text: draft.text, target: draft.target, input: draft.input, context: draft.context?.value ?? undefined,
        attachments: draft.attachments.map(item => ({id: item.id, file: {...item.file, mimeType: item.file.mimeType ?? ''}}))});
    return canonicalJson(summarize(view)) === canonicalJson(summarize(legacy));
}

function reportUpload(operationId: string, stage: string, started: number, bytes: number, error?: unknown): void {
    const code = (error as {code?: string})?.code;
    try {const data = {operationId, stage, bytes, result: error ? 'failure' : 'success', durationMs: Date.now() - started,
        ...(error ? {code: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'ATTACHMENT_PREPARATION_FAILED'} : {})};
        const log = createModuleLogger('session-chat-assets'); if (error) log.warn('chat.attachment', data); else log.info('chat.attachment', data);
    } catch { /* Asset results do not depend on diagnostics. */ }
}

import {createOperationLedger, type AttachmentRef, type ComposerDraft, type OperationLedger} from '@itookit/llm-ui';
import type {ConversationUIState, ISessionRepository} from '@itookit/llm-session/contracts';
import {randomUUID} from '@itookit/common';
import {AssetService} from '../services/AssetService';
import {DraftPersistence, readBranchDraft, type BranchDraft} from '../services/DraftPersistence';
import {persistOperations} from '../services/OperationPersistence';
import {readDraftFiles} from '../services/DraftFilesCodec';
import {readInputDraft} from '../domain/input-draft';
import {isTargetRef} from '@itookit/llm-flow/contracts';

type StoredBranch = BranchDraft & {inputView?: {version: 1; draft: ComposerDraft}};
/** Keep the existing branch draft and CAS conflict boundary while replacing its renderer. */
export class SessionChatStore {
    private readonly persistence: DraftPersistence;
    private tail: Promise<void> = Promise.resolve();
    private raw?: ConversationUIState;
    private saved!: ComposerDraft;
    private suspended = false;
    private constructor(private repository: ISessionRepository, readonly sessionId: string, readonly branch: string, readonly assets: AssetService) {
        this.persistence = new DraftPersistence(repository);
    }
    static async open(repository: ISessionRepository, sessionId: string, branch: string, assets: AssetService): Promise<SessionChatStore> {
        const store = new SessionChatStore(repository, sessionId, branch, assets);
        store.raw = await repository.getUIState(sessionId) ?? undefined;
        store.persistence.observe(sessionId, branch, store.raw);
        const stored = readBranchDraft(store.raw, branch) as StoredBranch | undefined;
        store.saved = restore(stored); return store;
    }
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
            const branch: StoredBranch = {...old, inputText: captured.text, inputToken: old?.inputToken ?? randomUUID(),
                inputTarget: isTargetRef(captured.target) ? captured.target : undefined,
                inputArguments: captured.input ? JSON.parse(JSON.stringify(captured.input)) : undefined,
                inputFiles: captured.attachments.map(item => ({id: item.file.id, name: item.file.name, type: item.file.mimeType ?? '', lastModified: 0, fileId: item.id})),
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
        signal.throwIfAborted(); const bytes = await file.arrayBuffer(); signal.throwIfAborted();
        const id = await this.assets.draftFiles().put(bytes); signal.throwIfAborted(); return {id, name: file.name, mimeType: file.type};
    }
    async files(refs: readonly AttachmentRef[], signal?: AbortSignal): Promise<File[]> {
        const files: File[] = [];
        for (const ref of refs) {signal?.throwIfAborted(); const bytes = await this.assets.draftFiles().read(ref.id);
            signal?.throwIfAborted(); files.push(new File([bytes], ref.name, {type: ref.mimeType}));}
        return files;
    }
}
function restore(stored?: StoredBranch): ComposerDraft {
    if (stored?.inputView) {
        const value = stored.inputView;
        if (value.version !== 1 || typeof value.draft?.text !== 'string' || !Array.isArray(value.draft.attachments)
            || !Number.isSafeInteger(value.draft.revision) || !Number.isSafeInteger(value.draft.textRevision)) throw new Error('Invalid stored ChatView draft');
        return structuredClone(value.draft);
    }
    const files = readDraftFiles(stored?.inputFiles ?? []);
    return {revision: 0, textRevision: 0, text: stored?.inputText ?? '', target: stored?.inputTarget,
        input: readInputDraft(stored?.inputArguments),
        attachments: files.map(file => ({id: file.fileId ?? randomUUID(), revision: 0, file: {id: file.id, name: file.name, mimeType: file.type}}))};
}

import {createModuleLogger, randomUUID} from '@itookit/common';
import {createOperationLedger, type AttachmentRef, type ComposerDraft, type OperationRecord} from '@itookit/llm-ui';
import type {ConversationComposerDraft, ConversationControls} from '@itookit/ui-common';
import {DraftDataCodec} from '../shell/drafts/session-draft-data';
import {restoreRemoteAttachments} from '../shell/remote-attachments';

const log = createModuleLogger('native-chat-storage');
interface StoredChat {version: 1; draft: ComposerDraft; operations: readonly OperationRecord[]}
/** One conditional host document stores the draft and operation journal together. */
export class NativeChatStore {
    private tail: Promise<unknown> = Promise.resolve();
    private uncertain?: {id: string; data: string};
    private suspended = false;
    private value!: StoredChat;
    private document: Record<string, unknown> = {};
    private savedDraft = '';
    private constructor(private controls: ConversationControls, private state: ConversationComposerDraft) {}
    static supported(controls: ConversationControls): boolean {
        return !!(controls.readComposerDraft && controls.saveComposerDraft && controls.putComposerAsset && controls.readComposerAsset);
    }
    static async open(controls: ConversationControls): Promise<NativeChatStore | undefined> {
        const state = await controls.readComposerDraft!(), store = new NativeChatStore(controls, state);
        store.document = state.data ? JSON.parse(state.data) : {};
        // Retain the existing recovery UI until its older submission is settled.
        if (store.document.remoteSubmission || controls.snapshot?.()?.pending && !store.document.independentChat) return undefined;
        await store.restore(); return store;
    }
    get draft(): ComposerDraft {return structuredClone(this.value.draft);}
    ledger() {
        return createOperationLedger({initial: this.value.operations, save: records => this.enqueue(async () => {
            const added = records.find(record => !this.value.operations.some(previous => previous.context.operationId === record.context.operationId));
            const draft = added?.draft && added.draft.revision >= this.value.draft.revision ? added.draft : this.value.draft;
            await this.write({...this.value, draft: structuredClone(draft), operations: structuredClone(records)});
        })});
    }
    saveDraft(draft: ComposerDraft): Promise<void> {
        const captured = structuredClone(draft);
        return this.enqueue(async () => {await this.write({...this.value, draft: captured});});
    }
    dirty(draft: ComposerDraft): boolean {return JSON.stringify(draft) !== this.savedDraft;}
    suspend(): void {this.suspended = true;}
    async upload(file: File, {signal}: {signal: AbortSignal}): Promise<AttachmentRef> {
        const started = Date.now(), operationId = randomUUID(); let stage = 'file-read';
        try {
            signal.throwIfAborted(); const bytes = await file.arrayBuffer(); signal.throwIfAborted(); stage = 'asset-write';
            const id = await this.controls.putComposerAsset!(bytes); signal.throwIfAborted();
            report(operationId, stage, started, undefined, file.size);
            return {id, name: file.name, mimeType: file.type};
        } catch (error) {report(operationId, stage, started, error, file.size); throw error;}
    }
    read(ref: AttachmentRef, {signal}: {signal: AbortSignal}): Promise<Blob> {
        signal.throwIfAborted();
        return this.controls.readComposerAsset!(ref.id).then(bytes => {signal.throwIfAborted(); return new Blob([bytes], {type: ref.mimeType});});
    }
    private async restore(): Promise<void> {
        const stored = this.document.independentChat as StoredChat | undefined;
        if (stored) {
            if (stored.version !== 1 || typeof stored.draft?.text !== 'string' || !Array.isArray(stored.draft.attachments)
                || !Array.isArray(stored.operations)) throw new Error('Unsupported stored chat draft');
            this.value = structuredClone(stored);
        } else {
            const codec = new DraftDataCodec({put: bytes => this.controls.putComposerAsset!(bytes), read: id => this.controls.readComposerAsset!(id)});
            const old = this.state.data ? await codec.decode(this.state.data) : undefined;
            const snapshot = this.controls.snapshot?.();
            const files = old?.files ?? restoreRemoteAttachments(snapshot?.draftAttachments ?? []);
            const signal = new AbortController().signal;
            const attachments = await Promise.all(files.map(async file => ({id: randomUUID(), revision: 0, file: await this.upload(file, {signal})})));
            const selection = old?.config?.settings.nativeModelSelection;
            this.value = {version: 1, operations: [], draft: {revision: 0, textRevision: 0,
                text: old?.config?.text ?? snapshot?.draft ?? '', attachments,
                ...(selection?.modelId ? {selection: {modelId: selection.modelId,
                    ...(selection.reasoningEffort ? {reasoningEffort: selection.reasoningEffort} : {})}} : {})}};
        }
        this.savedDraft = JSON.stringify(this.value.draft);
    }
    private enqueue(work: () => Promise<void>): Promise<void> {
        const pending = this.tail.catch(() => {}).then(work); this.tail = pending; return pending;
    }
    private async write(next: StoredChat): Promise<void> {
        if (this.suspended) throw Object.assign(new Error('Chat storage binding expired'), {code: 'STALE_VIEW'});
        if (this.uncertain) await this.reconcile();
        const data = JSON.stringify({...this.document, independentChat: next}), id = randomUUID(), started = Date.now();
        try {
            this.state = await this.controls.saveComposerDraft!(data, this.state.revision, id);
            if (this.state.data !== data) throw Object.assign(new Error('Saved chat differs from the proposed state'), {code: 'ECONFLICT'});
        } catch (error) {
            const failure = error as {outcome?: string; code?: string; remoteCode?: string};
            if (failure.outcome === 'not-committed' || ['ECONFLICT', 'EACCES', 'EINVAL'].includes(failure.remoteCode ?? failure.code ?? '')) {
                report(id, 'save', started, error); throw error;
            }
            this.uncertain = {id, data};
            try {await this.reconcile();} catch {report(id, 'save-unknown', started, error); throw error;}
        }
        this.value = next; this.document = JSON.parse(data); this.savedDraft = JSON.stringify(next.draft);
        report(id, 'save', started);
    }
    private async reconcile(): Promise<void> {
        const pending = this.uncertain!;
        const observed = await this.controls.readComposerDraft!();
        if (!observed.acceptedOperationIds.includes(pending.id))
            throw Object.assign(new Error('Chat save outcome is unknown; retry saving to query its receipt'), {code: 'SAVE_UNKNOWN'});
        this.uncertain = undefined;
        if (observed.data !== pending.data) throw Object.assign(new Error('Chat changed in another view; reopen to load the saved draft'), {code: 'ECONFLICT'});
        this.state = observed;
    }
}
function report(operationId: string, stage: string, started: number, error?: unknown, bytes?: number): void {
    const code = (error as {code?: unknown})?.code;
    try {const data = {operationId, stage, result: error ? 'failure' : 'success', bytes, durationMs: Date.now() - started,
        ...(error ? {code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CHAT_STORAGE_FAILED'} : {})};
        if (error) log.warn('native.chat.storage', data); else log.debug('native.chat.storage', data);
    } catch { /* Storage results do not depend on diagnostics. */ }
}

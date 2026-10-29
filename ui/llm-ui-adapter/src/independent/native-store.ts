import {StoredChatImages} from './stored-chat-images';
import type {ImageEditingHost} from './image-editing';
import {createModuleLogger, randomUUID} from '@itookit/common';
import {createOperationLedger, type AttachmentRef, type ComposerDraft, type OperationRecord} from '@itookit/llm-ui';
import type {ConversationComposerDraft, ConversationControls} from '@itookit/ui-common';
import {readDraftFiles} from '../services/DraftFilesCodec';
import {draftFileId} from '../domain/draft-file-identity';
import {DraftDataCodec} from '../shell/drafts/session-draft-data';
import {restoreRemoteAttachments} from '../shell/remote-attachments';

const log = createModuleLogger('native-chat-storage');
interface StoredChat {version: 1; draft: ComposerDraft; operations: readonly OperationRecord[]}
/** One conditional host document stores the draft and operation journal together. */
export class NativeChatStore {
    readonly images: StoredChatImages;
    private tail: Promise<unknown> = Promise.resolve();
    private uncertain?: {id: string; data: string};
    private suspended = false;
    private value!: StoredChat;
    private document: Record<string, unknown> = {};
    private savedDraft = '';
    private constructor(private controls: ConversationControls, private state: ConversationComposerDraft) {
        this.images = new StoredChatImages({upload: (file, options) => this.upload(file, options), read: (ref, options) => this.read(ref, options)});
    }
    static supported(controls: ConversationControls): boolean {
        return !!(controls.readComposerDraft && controls.saveComposerDraft && controls.putComposerAsset && controls.readComposerAsset);
    }
    static async open(controls: ConversationControls, conversationId?: string): Promise<NativeChatStore | undefined> {
        const state = await controls.readComposerDraft!(), store = new NativeChatStore(controls, state);
        store.document = state.data ? JSON.parse(state.data) : {};
        const id = conversationId ?? controls.snapshot?.()?.sessionId;
        if (id) store.identity(id);
        if (controls.snapshot?.()?.pending && !store.document.independentChat && !store.document.remoteSubmission) return undefined;
        await store.restore(); await store.restoreSubmission(); return store;
    }
    identity(fallback: string): string {
        const stored = this.document.chatConversationId;
        const identity = typeof stored === 'string' && stored ? stored : fallback;
        this.document.chatConversationId = identity; return identity;
    }
    /** Copy project-owned binaries before their draft can be retired; keep logical UI references stable. */
    async retainDraft(draft: ComposerDraft, read: (id: string) => Promise<ArrayBuffer>, signal: AbortSignal, images?: ImageEditingHost): Promise<void> {
        const aliases: Record<string, string> = Object.assign(Object.create(null), this.document.chatAssetAliases);
        const copy = async (id: string) => {
            if (Object.hasOwn(aliases, id)) return;
            signal.throwIfAborted(); const bytes = await read(id); signal.throwIfAborted();
            aliases[id] = await this.controls.putComposerAsset!(bytes); signal.throwIfAborted();
        };
        for (const item of draft.attachments) {await copy(item.file.id); await this.images.retain(item.file, images, copy);}
        this.document.chatAssetAliases = aliases;
        await this.saveDraft(draft);
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
        return this.enqueue(async () => {if (captured.revision >= this.value.draft.revision) await this.write({...this.value, draft: captured});});
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
        const aliases = this.document.chatAssetAliases as Record<string, string> | undefined;
        const id = aliases && Object.hasOwn(aliases, ref.id) ? aliases[ref.id] : ref.id;
        return this.controls.readComposerAsset!(id).then(bytes => {signal.throwIfAborted(); return new Blob([bytes], {type: ref.mimeType});});
    }
    private async restore(): Promise<void> {
        this.images.restore(this.document.chatImages as Parameters<StoredChatImages['restore']>[0], this.document.files as Parameters<StoredChatImages['restore']>[1]);
        const stored = this.document.independentChat as StoredChat | undefined;
        if (stored) {
            if (stored.version !== 1 || typeof stored.draft?.text !== 'string' || !Array.isArray(stored.draft.attachments)
                || !Array.isArray(stored.operations)) throw new Error('Unsupported stored chat draft');
            this.value = structuredClone(stored);
        } else {
            this.value = {version: 1, operations: [], draft: await this.legacyDraft(this.state.data, Number(this.document.composerVersion) || 0)};
        }
        this.savedDraft = JSON.stringify(this.value.draft);
    }
    private async legacyDraft(data?: string, revision = 0): Promise<ComposerDraft> {
        const codec = new DraftDataCodec({put: bytes => this.controls.putComposerAsset!(bytes), read: id => this.controls.readComposerAsset!(id)});
        const old = data ? await codec.decode(data) : undefined, document = data ? JSON.parse(data) : undefined;
        const files = old?.files ?? restoreRemoteAttachments(this.controls.snapshot?.()?.draftAttachments ?? []);
        const records = document?.version === 2 ? readDraftFiles(document.files) : [];
        const signal = new AbortController().signal;
        const attachments = await Promise.all(files.map(async (file, index) => ({id: draftFileId(file), revision: records[index]?.image?.revision ?? 0,
            file: records[index] ? {id: records[index].id, name: file.name, mimeType: file.type} : await this.upload(file, {signal})})));
        const model = old?.config?.settings.nativeModelSelection, resize = old?.config?.settings.imageResize;
        return {scopeId: old?.config?.draftToken ?? randomUUID(), revision, textRevision: revision,
            text: old?.config?.text ?? this.controls.snapshot?.()?.draft ?? '', attachments,
            selection: {...(model?.modelId ? {modelId: model.modelId, ...(model.reasoningEffort ? {reasoningEffort: model.reasoningEffort} : {})} : {}),
                ...(resize ? {imageResize: JSON.stringify(resize)} : {})}};
    }
    private async restoreSubmission(): Promise<void> {
        const marker = this.document.remoteSubmission as {id?: string; base?: string; version?: number; kind?: string} | undefined;
        if (!marker || this.value.operations.some(record => record.context.operationId === marker.id)) return;
        if (!marker.id || !Number.isSafeInteger(marker.version ?? 0) || !this.document.chatConversationId)
            throw Object.assign(new Error('Invalid legacy native submission identity'), {code: 'LEGACY_SUBMISSION_INVALID'});
        const draft = await this.legacyDraft(marker.base, marker.version ?? 0);
        const currentToken = this.state.data ? JSON.parse(this.state.data).config?.draftToken : undefined;
        const frozenToken = marker.base ? JSON.parse(marker.base).config?.draftToken : undefined;
        const scoped = currentToken === frozenToken ? {...draft, scopeId: this.value.draft.scopeId} : draft;
        const operation: OperationRecord = {context: {operationId: marker.id, viewId: `legacy:${marker.id}`},
            conversationId: String(this.document.chatConversationId), kind: marker.kind === 'command' ? 'command' : 'send', status: 'unknown', draft: scoped,
            input: {protocol: 'legacy-composer-v1', kind: 'action', text: draft.text, attachments: draft.attachments.map(item => ({...item.file}))}};
        this.value = {...this.value, operations: [...this.value.operations, operation]};
    }
    private enqueue(work: () => Promise<void>): Promise<void> {
        const pending = this.tail.catch(() => {}).then(work); this.tail = pending; return pending;
    }
    private async write(next: StoredChat): Promise<void> {
        if (this.suspended) throw Object.assign(new Error('Chat storage binding expired'), {code: 'STALE_VIEW'});
        if (this.uncertain) await this.reconcile();
        const document = {...this.document}, marker = document.remoteSubmission as {id?: string} | undefined;
        if (marker && next.operations.some(record => record.context.operationId === marker.id && ['accepted', 'rejected'].includes(record.status))) delete document.remoteSubmission;
        const data = JSON.stringify({...document, independentChat: next, chatImages: this.images.snapshot()}), id = randomUUID(), started = Date.now();
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

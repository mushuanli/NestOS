import {StoredChatImages} from '../../independent/stored-chat-images';
import {chatSettings} from '../chat-settings';
import {readInputDraft} from '../../domain/input-draft';
import {randomUUID} from '@itookit/common';
import type {AttachmentRef, ComposerDraft} from '@itookit/llm-ui';
import type {SessionDraftControls} from '@itookit/ui-common';
import {DraftDataCodec} from './session-draft-data';
import {DraftFilesCodec, type DraftFilePort} from '../../services/DraftFilesCodec';
import {draftFileId} from '../../domain/draft-file-identity';
import type {IChatInputConfig} from '../../domain/ports/IChatInputPresenter';
import {fileBytes} from '../../utils/file-bytes';

/** Keep project persistence compatible while the shared composer owns editing identities. */
export class ChatDraftStore {
    private readonly codec: DraftDataCodec;
    private readonly filesCodec: DraftFilesCodec;
    private readonly files = new Map<string, File>();
    readonly images: StoredChatImages;
    private saved = '';
    private config: IChatInputConfig = {text: '', agentId: 'default', settings: {}};
    readonly read: DraftFilePort['read'];
    draft!: ComposerDraft;
    constructor(private readonly controls: SessionDraftControls) {
        this.filesCodec = new DraftFilesCodec(controls.attachments); this.codec = new DraftDataCodec(controls.attachments, this.filesCodec);
        this.read = async id => {
            const local = this.files.get(id); if (local) return fileBytes(local);
            if (!controls.attachments) throw new Error('Draft attachment storage is unavailable');
            return controls.attachments.read(id);
        };
        this.images = new StoredChatImages({upload: (file, options) => this.upload(file, options),
            read: async (ref, {signal}) => {signal.throwIfAborted(); const bytes = await this.read(ref.id); signal.throwIfAborted(); return new Blob([bytes], {type: ref.mimeType});}});
    }
    async open(): Promise<void> {
        const decoded = await this.codec.decode(this.controls.initialData);
        this.config = decoded.config ?? this.config;
        const document = this.controls.initialData ? JSON.parse(this.controls.initialData) : undefined;
        this.images.restore(document?.chatImages, document?.files);
        const records = await this.filesCodec.encode(decoded.files);
        const attachments = records.map((record, index) => {
            this.files.set(record.id, decoded.files[index]);
            return {id: draftFileId(decoded.files[index]), revision: 0, file: {id: record.id, name: record.name, mimeType: record.type}};
        });
        const stored = this.controls.initialData ? JSON.parse(this.controls.initialData).chatDraft as ComposerDraft | undefined : undefined;
        if (stored && (typeof stored.text !== 'string' || !Array.isArray(stored.attachments) || !Number.isSafeInteger(stored.revision)))
            throw Object.assign(new Error('Invalid stored ChatView draft'), {code: 'DRAFT_FORMAT_INVALID'});
        this.draft = stored ? {...stored, attachments} : {scopeId: this.config.draftToken ?? randomUUID(), revision: 0, textRevision: 0,
            text: this.config.text, attachments, target: this.config.target, input: this.config.input,
            selection: {executorId: this.config.agentId, ...selection(this.config.settings)},
            ...(this.config.context ? {context: {revision: this.config.context.revision, value: JSON.parse(JSON.stringify(this.config.context))}} : {})};
        if (stored) this.draft = {...this.draft, attachments: this.draft.attachments.map(item => ({...item,
            revision: stored.attachments.find(previous => previous.id === item.id)?.revision ?? 0}))};
        this.saved = JSON.stringify(this.draft);
    }
    async upload(file: File, {signal}: {signal: AbortSignal}): Promise<AttachmentRef> {
        signal.throwIfAborted(); const [stored] = await this.filesCodec.encode([file]); signal.throwIfAborted(); this.files.set(stored.id, file);
        return {id: stored.id, name: file.name, mimeType: file.type};
    }
    async readFiles(refs: readonly AttachmentRef[]): Promise<File[]> {
        return Promise.all(refs.map(async ref => {
            const cached = this.files.get(ref.id); if (cached) return cached;
            const file = new File([await this.read(ref.id)], ref.name, {type: ref.mimeType}); this.files.set(ref.id, file); return file;
        }));
    }
    preferences(draft: ComposerDraft = this.draft): IChatInputConfig {
        return {...this.config, text: draft.text, draftToken: draft.scopeId, target: draft.target as IChatInputConfig['target'], input: readInputDraft(draft.input),
            agentId: draft.target?.kind === 'agent' ? draft.target.id : draft.selection?.executorId ?? this.config.agentId,
            settings: {...this.config.settings, ...chatSettings(draft.selection), ...(draft.selection?.modelId ? {nativeModelSelection: {executorId: draft.selection.executorId ?? this.config.agentId, modelId: draft.selection.modelId,
                ...(draft.selection.reasoningEffort ? {reasoningEffort: draft.selection.reasoningEffort} : {})}} : {})},
            context: draft.context?.value == null ? undefined : draft.context.value as unknown as IChatInputConfig['context']};
    }
    async save(draft: ComposerDraft): Promise<void> {
        const config = this.preferences(draft), files = await this.readFiles(draft.attachments.map(item => item.file));
        const encoded = JSON.parse(await this.codec.encode(config, files));
        encoded.files = encoded.files.map((file: object, index: number) => ({...file, fileId: draft.attachments[index].id}));
        encoded.files = this.images.records(encoded.files);
        await this.controls.save?.(JSON.stringify({...encoded, chatDraft: draft, chatImages: this.images.snapshot()}));
        this.config = config; this.draft = structuredClone(draft); this.saved = JSON.stringify(draft);
    }
    dirty(draft: ComposerDraft): boolean {return JSON.stringify(draft) !== this.saved;}
}
function selection(value: IChatInputConfig['settings']): Record<string, string> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => ['string', 'boolean', 'number'].includes(typeof item)).map(([key, item]) => [key, String(item)]));
}

import type { SessionDraftControls } from '@itookit/ui-common';
import type { IChatInputConfig } from '../../domain/ports/IChatInputPresenter';
import {readInputDraft} from '../../domain/input-draft';
import {isTargetRef} from '@itookit/llm-flow/contracts';
import {readInputContextDraft} from '../../domain/context-draft';
import {DraftFilesCodec, type DraftFileRecord} from '../../services/DraftFilesCodec';
import {validDraftToken} from '../../domain/draft-file-identity';

type AttachmentPort = NonNullable<SessionDraftControls['attachments']>;
interface StoredDraft { version: 2; config: IChatInputConfig; files: DraftFileRecord[] }
interface LegacyDraft { version: 1; config: IChatInputConfig; files: (Omit<DraftFileRecord, 'id'> & { content: string })[] }

/** Binary storage belongs to the host; JSON contains only composer state and opaque references. */
export class DraftDataCodec {
    private readonly files: DraftFilesCodec;
    constructor(attachments?: AttachmentPort, files?: DraftFilesCodec) {this.files = files ?? new DraftFilesCodec(attachments);}
    async encode(config: IChatInputConfig, files: File[]): Promise<string> {
        const snapshot = structuredClone(config);
        if (snapshot.draftToken !== undefined && !validDraftToken(snapshot.draftToken))
            throw Object.assign(new Error('Invalid draft identity'), {code: 'DRAFT_IDENTITY_INVALID'});
        if (snapshot.context !== undefined) snapshot.context = readInputContextDraft(snapshot.context);
        return JSON.stringify({version: 2, config: snapshot, files: await this.files.encode(files)} satisfies StoredDraft);
    }
    async decode(data?: string): Promise<{ config?: IChatInputConfig; files: File[]; migrated?: boolean }> {
        if (!data) return { files: [] };
        const draft = JSON.parse(data) as StoredDraft | LegacyDraft;
        if (![1, 2].includes(draft.version) || typeof draft.config?.text !== 'string' || !Array.isArray(draft.files)) throw new Error('Invalid project draft');
        if (draft.config.target !== undefined && !isTargetRef(draft.config.target)) throw new Error('Invalid project draft target');
        if (draft.config.draftToken !== undefined && !validDraftToken(draft.config.draftToken))
            throw Object.assign(new Error('Invalid draft identity'), {code: 'DRAFT_IDENTITY_INVALID'});
        if (draft.config.input !== undefined) draft.config.input = readInputDraft(draft.config.input);
        if (draft.config.context !== undefined) draft.config.context = readInputContextDraft(draft.config.context);
        if (draft.version === 1) return { config: draft.config, migrated: true, files: draft.files.map(file => new File([
            Uint8Array.from(atob(file.content), char => char.charCodeAt(0)),
        ], file.name, { type: file.type, lastModified: file.lastModified })) };
        return {config: draft.config, files: await this.files.decode(draft.files)};
    }
}

import type { SessionDraftControls } from '@itookit/ui-common';
import type { IChatInputConfig } from '../../domain/ports/IChatInputPresenter';

type AttachmentPort = NonNullable<SessionDraftControls['attachments']>;
interface StoredFile { name: string; type: string; lastModified: number; id: string }
interface StoredDraft { version: 2; config: IChatInputConfig; files: StoredFile[] }
interface LegacyDraft { version: 1; config: IChatInputConfig; files: (Omit<StoredFile, 'id'> & { content: string })[] }

/** Binary storage belongs to the host; JSON contains only composer state and opaque references. */
export class DraftDataCodec {
    private readonly encoded = new WeakMap<File, Promise<StoredFile>>();
    constructor(private readonly attachments?: AttachmentPort) {}
    async encode(config: IChatInputConfig, files: File[]): Promise<string> {
        const snapshot = structuredClone(config);
        return JSON.stringify({ version: 2, config: snapshot, files: await Promise.all(files.map(file => this.encodeFile(file))) } satisfies StoredDraft);
    }
    async decode(data?: string): Promise<{ config?: IChatInputConfig; files: File[]; migrated?: boolean }> {
        if (!data) return { files: [] };
        const draft = JSON.parse(data) as StoredDraft | LegacyDraft;
        if (![1, 2].includes(draft.version) || typeof draft.config?.text !== 'string' || !Array.isArray(draft.files)) throw new Error('Invalid project draft');
        if (draft.version === 1) return { config: draft.config, migrated: true, files: draft.files.map(file => new File([
            Uint8Array.from(atob(file.content), char => char.charCodeAt(0)),
        ], file.name, { type: file.type, lastModified: file.lastModified })) };
        const files = await Promise.all(draft.files.map(async stored => {
            const file = new File([await this.port().read(stored.id)], stored.name, stored);
            this.encoded.set(file, Promise.resolve(stored)); return file;
        }));
        return { config: draft.config, files };
    }
    private encodeFile(file: File): Promise<StoredFile> {
        let pending = this.encoded.get(file);
        if (!pending) {
            pending = readBytes(file).then(async content => ({ name: file.name, type: file.type,
                lastModified: file.lastModified, id: await this.port().put(content) }));
            this.encoded.set(file, pending);
            void pending.catch(() => this.encoded.delete(file));
        }
        return pending;
    }
    private port(): AttachmentPort {
        if (!this.attachments) throw new Error('Draft attachment storage is unavailable');
        return this.attachments;
    }
}
function readBytes(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
    });
}

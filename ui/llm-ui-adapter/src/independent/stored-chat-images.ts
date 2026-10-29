import {randomUUID} from '@itookit/common';
import {resolveResize, validateSpec, type ImageResizePolicy} from '@itookit/image-parser';
import type {AttachmentRef} from '@itookit/llm-ui';
import type {DraftFileRecord} from '../services/DraftFilesCodec';
import type {ImageAssetMetadata, ImageEditingHost} from './image-editing';

type Binaries = Pick<ImageEditingHost, 'read' | 'upload'>;
/** Image edit metadata stays beside host drafts; the independent UI only sees an image port. */
export class StoredChatImages {
    private readonly metadata = new Map<string, ImageAssetMetadata>();
    private readonly listeners = new Set<() => void>();
    constructor(private readonly binaries: Binaries) {}
    restore(value?: Readonly<Record<string, ImageAssetMetadata>>, records: readonly DraftFileRecord[] = []): void {
        this.metadata.clear();
        for (const record of records) if (record.image) {
            let resize: ImageResizePolicy | undefined;
            try {resize = record.image.resizeKey ? JSON.parse(record.image.resizeKey) : undefined;} catch { /* Old resize keys are not structured policies. */ }
            this.set(record.id, {original: {id: record.image.original.id, name: record.image.original.name, mimeType: record.image.original.type},
                spec: record.image.spec, resize: resolveResize(resize)});
        }
        for (const [id, metadata] of Object.entries(value ?? {})) this.set(id, metadata);
    }
    set(id: string, metadata: ImageAssetMetadata): void {
        this.metadata.set(id, {...structuredClone(metadata), spec: validateSpec(metadata.spec), resize: resolveResize(metadata.resize)});
    }
    snapshot(): Record<string, ImageAssetMetadata> {return structuredClone(Object.fromEntries(this.metadata));}
    host(getResize: () => ImageResizePolicy, setResize: (resize: ImageResizePolicy) => void): ImageEditingHost {
        return {...this.binaries, loadMetadata: async ref => {const value = this.metadata.get(ref.id); return value && structuredClone(value);},
            saveMetadata: async (ref, value) => {this.set(ref.id, value);}, getResize,
            setResize: resize => {setResize(resize); this.changed();},
            subscribeResize: listener => {this.listeners.add(listener); return () => {this.listeners.delete(listener);}}};
    }
    changed(): void {for (const listener of this.listeners) listener();}
    records(records: readonly DraftFileRecord[]): DraftFileRecord[] {
        return records.map(record => {
            const metadata = this.metadata.get(record.id); if (!metadata) return record;
            return {...record, image: {id: record.image?.id ?? record.fileId ?? randomUUID(), revision: record.image?.revision ?? 0,
                original: {id: metadata.original.id, name: metadata.original.name, type: metadata.original.mimeType ?? '', lastModified: 0},
                spec: metadata.spec, resizeKey: JSON.stringify(metadata.resize)}};
        });
    }
    async retain(ref: AttachmentRef, source: ImageEditingHost | undefined, copy: (id: string) => Promise<void>): Promise<void> {
        const metadata = await source?.loadMetadata(ref); if (!metadata) return;
        await copy(metadata.original.id); this.set(ref.id, metadata);
    }
}

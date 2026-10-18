import {t} from '@itookit/common';
import {createBlobSource, type ImageProcessor, type ImageResizePolicy} from '@itookit/image-parser';
import {ImageProcessingSession} from './image-processing-session';
import {imageFileState, setImageFileState} from './image-file-state';
import {editImageFiles} from './file-image-editing';

export interface ImageAttachmentOptions {
    getFiles(): File[]; setFiles(files: File[]): void;
    getResize(): ImageResizePolicy; changed(): void; flush?(): Promise<void>;
    persist?(files: File[], resize: ImageResizePolicy): Promise<void>;
    setResize?(resize: ImageResizePolicy): void;
    processor?: ImageProcessor;
}
/** Owns derived files; immutable File identity also fences acceptance cleanup. */
export class ImageAttachments {
    private readonly processing: ImageProcessingSession;
    private lifetime = new AbortController();
    private operation?: AbortController;
    private signature = '';
    private queued: Promise<void> = Promise.resolve();
    private pending = false;
    private dialog = false;
    private failure?: unknown;
    constructor(private readonly options: ImageAttachmentOptions) {this.processing = new ImageProcessingSession(options.getResize, options.processor);}
    get busy(): boolean {return this.pending || this.dialog || !!this.failure;}
    get error(): unknown {return this.failure;}
    refresh(force = false): void {
        if (this.lifetime.signal.aborted || this.dialog) return;
        const files = this.options.getFiles().filter(file => file.type.startsWith('image/'));
        if (!files.length) {
            if (this.signature !== 'none') {this.signature = 'none'; this.operation?.abort(); this.pending = false; this.failure = undefined; this.options.changed();}
            return;
        }
        let resize: ImageResizePolicy;
        try {resize = this.processing.getResize();} catch (error) {
            this.operation?.abort(); this.pending = false;
            if (force || this.signature !== 'invalid-policy') {this.signature = 'invalid-policy'; this.failure = error; this.options.changed();}
            return;
        }
        const key = this.processing.getKey(resize), signature = JSON.stringify([key, files.map(file => {const s = imageFileState(file); return [s.id, s.revision];})]);
        if (!force && signature === this.signature) return;
        this.signature = signature; this.operation?.abort(); this.operation = new AbortController(); const operation = this.operation;
        this.failure = undefined; const todo = files.filter(file => imageFileState(file).resizeKey !== key);
        this.pending = todo.length > 0; this.options.changed();
        if (!todo.length) return;
        this.queued = this.queued.catch(() => {}).then(async () => {
            if (operation.signal.aborted || this.lifetime.signal.aborted) return;
            try {await this.process(todo, resize, operation.signal);}
            catch (error) {if (!operation.signal.aborted) this.failure = error;}
            finally {if (this.operation === operation) {this.pending = false; this.options.changed();}}
        });
    }
    private async process(files: File[], resize: ImageResizePolicy, signal: AbortSignal): Promise<void> {
        const replacements = new Map<File, File>();
        const metadata: Array<() => void> = [];
        for (const file of files) {
            const state = imageFileState(file), source = createBlobSource(state.original, {id: state.id, revision: 'original', name: state.original.name});
            const output = await this.processing.process(source, state.spec, signal, resize);
            if (signal.aborted || this.lifetime.signal.aborted) return;
            const next = new File([output.blob], file.name, {type: output.mimeType});
            metadata.push(() => setImageFileState(next, {...state, revision: state.revision + 1, resizeKey: this.processing.getKey(resize)})); replacements.set(file, next);
        }
        if (signal.aborted || this.lifetime.signal.aborted) return;
        metadata.forEach(apply => apply());
        if (replacements.size) this.options.setFiles(this.options.getFiles().map(file => replacements.get(file) ?? file));
        this.signature = ''; this.refresh();
    }
    async open(file: File): Promise<void> {
        if (this.busy || !this.options.getFiles().includes(file)) return;
        this.dialog = true; this.options.changed();
        try {await editImageFiles(this.options, this.processing.engine, file, this.lifetime.signal);}
        catch (error) {if (!this.lifetime.signal.aborted) this.failure = error;}
        finally {this.dialog = false; this.options.changed(); this.refresh();}
    }
    async ready(): Promise<void> {await this.queued; if (this.busy) throw this.failure ?? new Error(t('image.processing'));}
    destroy(): void {this.lifetime.abort(); this.operation?.abort();
        void this.processing.dispose();}
}

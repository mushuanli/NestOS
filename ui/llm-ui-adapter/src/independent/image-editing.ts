import type {AttachmentRef, DraftAttachment, ImageEditingPort} from '@itookit/llm-ui';
import {createBlobSource, DEFAULT_IMAGE_SPEC, validateSpec, resolveResize,
    type ImageResizePolicy, type ImageSpec, type ImageProcessor, type PreparedImage} from '@itookit/image-parser';
import {randomUUID, t} from '@itookit/common';
import {openImageDialog} from '../components/input/image-dialog';
import {ImageProcessingSession} from '../components/input/image-processing-session';

export interface ImageAssetMetadata {original: AttachmentRef; spec: ImageSpec; resize: ImageResizePolicy; processorVersion?: string}
export interface ImageEditingHost {
    read(ref: AttachmentRef, options: {signal: AbortSignal}): Promise<Blob>;
    upload(file: File, options: {signal: AbortSignal}): Promise<AttachmentRef>;
    loadMetadata(ref: AttachmentRef): Promise<ImageAssetMetadata | undefined>;
    saveMetadata(ref: AttachmentRef, metadata: ImageAssetMetadata): Promise<void>;
    commit?(changes: NonNullable<Awaited<ReturnType<ImageEditingPort['edit']>>>, resize: ImageResizePolicy): Promise<void>;
    getResize(): ImageResizePolicy;
    setResize?(resize: ImageResizePolicy): void;
    subscribeResize?(changed: () => void): () => void;
    processor?: ImageProcessor;
}
/** Inject through ChatOptions.imageEditing; root llm-ui never imports this library. */
export function createImageEditingPort(host: ImageEditingHost): ImageEditingPort & {dispose(): Promise<void>} {
    const processing = new ImageProcessingSession(() => host.getResize(), host.processor);
    const pending = new WeakMap<File, {original: File; resize: ImageResizePolicy}>();
    return {
        getRevision: () => JSON.stringify([processing.getResize(), processing.engine.version]),
        subscribe: changed => host.subscribeResize?.(changed) ?? (() => {}),
        refresh: (items, {signal}) => refreshGroup(host, processing, items, signal),
        async prepare(original, {signal}) {
            if (!original.type.startsWith('image/')) return original;
            const source = createBlobSource(original, {id: randomUUID(), revision: 'original', name: original.name});
            const resize = processing.getResize();
            const output = await processing.process(source, DEFAULT_IMAGE_SPEC, signal, resize);
            const file = !output.changed && original.type === output.mimeType ? original : new File([output.blob], original.name, {type: output.mimeType});
            pending.set(file, {original, resize}); return file;
        },
        async uploaded(file, ref, {signal}) {
            const data = pending.get(file); if (!data) return; signal.throwIfAborted();
            processing.assertPolicy(data.resize, signal);
            const original = data.original === file ? ref : await host.upload(data.original, {signal}); signal.throwIfAborted();
            processing.assertPolicy(data.resize, signal);
            await host.saveMetadata(ref, {original, spec: DEFAULT_IMAGE_SPEC, resize: data.resize, processorVersion: processing.engine.version});
            processing.assertPolicy(data.resize, signal); pending.delete(file);
        },
        edit: (items, activeId, {signal}) => editGroup(host, processing.engine, items, activeId, signal),
        dispose: () => processing.dispose(),
    };
}
async function editGroup(host: ImageEditingHost, processor: ImageProcessor, attachments: readonly DraftAttachment[], activeId: string, signal: AbortSignal) {
    const items = await Promise.all(attachments.map(async item => {
        const metadata = await host.loadMetadata(item.file), original = metadata?.original ?? item.file;
        return {id: item.id, revision: item.revision ?? 0, original: {id: original.id, revision: original.id, name: original.name,
            read: (options: {signal: AbortSignal}) => host.read(original, options)}, spec: validateSpec(metadata?.spec ?? DEFAULT_IMAGE_SPEC)};
    }));
    signal.throwIfAborted(); const resize = resolveResize(host.getResize()), policy = JSON.stringify(resize);
    let replacements: Awaited<ReturnType<ImageEditingPort['edit']>>;
    await openImageDialog({items, activeId, processor, resize, signal, own: () => {}, save: async (changes, nextResize) => {
        if (JSON.stringify(host.getResize()) !== policy) throw new Error(t('image.conflict'));
        const next = await storeChanges(host, attachments, changes, nextResize, signal, processor.version);
        if (JSON.stringify(resolveResize(host.getResize())) !== policy) throw new Error(t('image.conflict'));
        await host.commit?.(next, nextResize); signal.throwIfAborted(); replacements = next;
        if (JSON.stringify(nextResize) !== policy) host.setResize?.(nextResize);
    }});
    return replacements;
}
async function storeChanges(host: ImageEditingHost, attachments: readonly DraftAttachment[], changes: readonly PreparedImage[], resize: ImageResizePolicy, signal: AbortSignal, processorVersion: string) {
    const result: NonNullable<Awaited<ReturnType<ImageEditingPort['edit']>>>[number][] = [];
    for (const change of changes) {
        if (change.output.purpose !== 'export') throw new Error(t('image.conflict'));
        const item = attachments.find(value => value.id === change.itemId); if (!item) throw new Error(t('image.conflict'));
        const metadata = await host.loadMetadata(item.file), original = metadata?.original ?? item.file; signal.throwIfAborted();
        const ref = await host.upload(new File([change.output.blob], item.file.name, {type: change.output.mimeType}), {signal});
        await host.saveMetadata(ref, {original, spec: change.spec, resize, processorVersion}); signal.throwIfAborted();
        result.push({id: item.id, expectedFileId: item.file.id, expectedRevision: change.expectedRevision, file: ref});
    }
    return result;
}

async function refreshGroup(host: ImageEditingHost, processing: ImageProcessingSession, items: readonly DraftAttachment[], signal: AbortSignal) {
    const resize = processing.getResize(), changes: NonNullable<Awaited<ReturnType<ImageEditingPort['edit']>>>[number][] = [];
    for (const item of items) {
        const metadata = await host.loadMetadata(item.file); processing.assertPolicy(resize, signal);
        if (metadata && JSON.stringify(metadata.resize) === JSON.stringify(resize) && metadata.processorVersion === processing.engine.version) continue;
        const original = metadata?.original ?? item.file, spec = validateSpec(metadata?.spec ?? DEFAULT_IMAGE_SPEC);
        const source = {id: original.id, revision: original.id, name: original.name, read: (options: {signal: AbortSignal}) => host.read(original, options)};
        const output = await processing.process(source, spec, signal, resize);
        const file = await host.upload(new File([output.blob], item.file.name, {type: output.mimeType}), {signal});
        processing.assertPolicy(resize, signal);
        await host.saveMetadata(file, {original, spec, resize, processorVersion: processing.engine.version}); processing.assertPolicy(resize, signal);
        changes.push({id: item.id, expectedFileId: item.file.id, expectedRevision: item.revision ?? 0, file});
    }
    processing.assertPolicy(resize, signal); return changes;
}

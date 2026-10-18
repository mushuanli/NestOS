import type {AttachmentRef, DraftAttachment, ImageEditingPort} from '@itookit/llm-ui';
import type {ImageProcessor, ImageResizePolicy} from '@itookit/image-parser';
import {randomUUID, t} from '@itookit/common';
import {createImageEditingPort, type ImageAssetMetadata} from '../../independent/image-editing';
import {imageFileState, setImageFileState} from './image-file-state';
import type {ImageAttachmentOptions} from './ImageAttachments';
import {imageProcessingKey} from './image-processing-session';
type Changes = NonNullable<Awaited<ReturnType<ImageEditingPort['edit']>>>;

/** Compatibility composers use the same host adapter as independent ChatView. */
export async function editImageFiles(options: ImageAttachmentOptions, processor: ImageProcessor, active: File, signal: AbortSignal): Promise<void> {
    const files = options.getFiles().filter(file => file.type.startsWith('image/'));
    const assets = new Map<string, File>(), metadata = new Map<string, ImageAssetMetadata>();
    const register = (file: File): AttachmentRef => {
        const ref = {id: randomUUID(), name: file.name, mimeType: file.type}; assets.set(ref.id, file); return ref;
    };
    const items: DraftAttachment[] = files.map(file => {
        const state = imageFileState(file), ref = register(file);
        metadata.set(ref.id, {original: register(state.original), spec: state.spec, resize: options.getResize()});
        return {id: state.id, revision: state.revision, file: ref};
    });
    const port = createImageEditingPort({processor, getResize: options.getResize,
        read: async ref => {const file = assets.get(ref.id); if (!file) throw new Error(t('image.conflict')); return file;},
        upload: async file => register(file), loadMetadata: async ref => metadata.get(ref.id),
        saveMetadata: async (ref, value) => {metadata.set(ref.id, value);},
        commit: (changes, resize) => commitFiles(options, files, changes, assets, metadata, resize, signal, processor)});
    try {await port.edit(items, imageFileState(active).id, {signal});} finally {await port.dispose();}
}
async function commitFiles(options: ImageAttachmentOptions, originals: File[], changes: Changes, assets: Map<string, File>,
    metadata: Map<string, ImageAssetMetadata>, resize: ImageResizePolicy, signal: AbortSignal, processor: ImageProcessor): Promise<void> {
    const before = options.getFiles(), replacements = new Map<File, File>();
    for (const change of changes) {
        const file = originals.find(value => imageFileState(value).id === change.id), next = assets.get(change.file.id), data = metadata.get(change.file.id);
        if (!file || !before.includes(file) || imageFileState(file).revision !== change.expectedRevision || !next || !data) throw new Error(t('image.conflict'));
        const key = imageProcessingKey(resize, processor);
        setImageFileState(next, {...imageFileState(file), revision: change.expectedRevision + 1, spec: data.spec, resizeKey: key});
        replacements.set(file, next);
    }
    const next = before.map(file => replacements.get(file) ?? file);
    signal.throwIfAborted(); await options.persist?.(next, resize); signal.throwIfAborted();
    const current = options.getFiles();
    if (current.length !== before.length || current.some((file, index) => file !== before[index])) throw new Error(t('image.conflict'));
    if (JSON.stringify(options.getResize()) !== JSON.stringify(resize)) options.setResize?.(resize);
    options.setFiles(next); if (!options.persist) await options.flush?.();
}

import {expect, it, vi} from 'vitest';
import type {ImageProcessor, ImageOutput, ImageResizePolicy, ImageSource} from '@itookit/image-parser';
import {createImageEditingPort, type ImageAssetMetadata} from './image-editing';

function fixture(process: ImageProcessor['process']) {
    let resize: ImageResizePolicy = {mode: 'max-edge', maxEdge: 1024}, serial = 0;
    const assets = new Map<string, Blob>(), metadata = new Map<string, ImageAssetMetadata>();
    const upload = vi.fn(async (file: File) => {const id = String(++serial); assets.set(id, file); return {id, name: file.name, mimeType: file.type};});
    const port = createImageEditingPort({getResize: () => resize, upload, loadMetadata: async ref => metadata.get(ref.id),
        saveMetadata: async (ref, value) => {metadata.set(ref.id, value);}, read: async ref => assets.get(ref.id)!,
        processor: {id: 'image-parser', version: 'test', process, dispose: async () => {}} as ImageProcessor});
    return {port, assets, metadata, upload, resize(value: ImageResizePolicy) {resize = value;}};
}
function output(source: ImageSource, changed = true): ImageOutput {
    const blob = new Blob(['processed'], {type: 'image/png'});
    return {sourceId: source.id, sourceRevision: source.revision, blob, mimeType: blob.type, width: 1024, height: 600,
        byteLength: blob.size, changed, purpose: 'export'};
}
it('rejects a non-cancellable processing result when its captured policy is obsolete', async () => {
    let finish!: () => void;
    const host = fixture(async source => new Promise(resolve => {finish = () => resolve(output(source));}));
    const preparing = host.port.prepare!(new File(['original'], 'photo.png', {type: 'image/png'}), {signal: new AbortController().signal});
    host.resize({mode: 'max-edge', maxEdge: 2048}); finish();
    await expect(preparing).rejects.toThrow(); expect(host.upload).not.toHaveBeenCalled(); await host.port.dispose();
});
it('rebuilds derived resources from the immutable original after a policy change', async () => {
    const sources: string[] = [], host = fixture(async source => {sources.push(source.id); return output(source);});
    const original = {id: 'original', name: 'photo.png', mimeType: 'image/png'}, derived = {id: 'derived', name: 'photo.png', mimeType: 'image/png'};
    host.assets.set(original.id, new Blob(['original'])); host.metadata.set(derived.id, {original,
        spec: {version: 1, selection: {kind: 'none'}}, resize: {mode: 'max-edge', maxEdge: 1024}, processorVersion: 'test'});
    const items = [{id: 'item', revision: 3, file: derived}], signal = new AbortController().signal;
    expect(await host.port.refresh!(items, {signal})).toEqual([]);
    host.resize({mode: 'max-edge', maxEdge: 2048});
    const changes = await host.port.refresh!(items, {signal});
    expect(sources).toEqual(['original']); expect(changes).toMatchObject([{id: 'item', expectedFileId: 'derived', expectedRevision: 3}]);
    expect(host.metadata.get(changes![0].file.id)?.original).toEqual(original); await host.port.dispose();
});
it('uploads an unchanged original once while retaining its editing metadata', async () => {
    const host = fixture(async source => output(source, false)), signal = new AbortController().signal;
    const original = new File(['original'], 'photo.png', {type: 'image/png'}), prepared = await host.port.prepare!(original, {signal});
    expect(prepared).toBe(original); const ref = await host.upload(prepared);
    await host.port.uploaded!(prepared, ref, {signal}); expect(host.upload).toHaveBeenCalledOnce();
    expect(host.metadata.get(ref.id)?.original).toEqual(ref); await host.port.dispose();
});

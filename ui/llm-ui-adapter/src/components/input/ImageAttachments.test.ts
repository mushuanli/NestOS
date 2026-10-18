import {expect, it, vi} from 'vitest';
import {ImageAttachments} from './ImageAttachments';
import {imageFileState} from './image-file-state';
import type {ImageOutput, ImageProcessor, ImageResizePolicy, ImageSource, ImageSpec, ProcessOptions} from '@itookit/image-parser';

function fixture(process: (source: ImageSource, spec: ImageSpec, options: ProcessOptions) => Promise<ImageOutput>) {
    let files = [new File(['original'], 'photo.png', {type: 'image/png'})], resize: ImageResizePolicy = {mode: 'max-edge', maxEdge: 1024};
    const changed = vi.fn(), disposed = vi.fn(), setFiles = vi.fn((next: File[]) => {files = next;});
    const images = new ImageAttachments({getFiles: () => files, setFiles, getResize: () => resize, changed,
        processor: {process, dispose: disposed} as unknown as ImageProcessor});
    return {images, changed, setFiles, disposed, get files() {return files;}, replace(next: File[]) {files = next; images.refresh();},
        resize(next: ImageResizePolicy) {resize = next; images.refresh();}};
}
function output(source: ImageSource, text = 'derived'): ImageOutput {
    const blob = new Blob([text], {type: 'image/png'});
    return {sourceId: source.id, sourceRevision: source.revision, blob, width: 1024, height: 683, byteLength: blob.size,
        mimeType: blob.type, changed: true, purpose: 'export'};
}
it('regenerates from the preserved original when the effective agent preference changes', async () => {
    const inputs: string[] = [], process = vi.fn(async (source: ImageSource) => {inputs.push((await source.read({signal: new AbortController().signal})).size.toString()); return output(source);});
    const state = fixture(process), original = state.files[0];
    state.images.refresh(); await state.images.ready(); const first = state.files[0];
    expect(first).not.toBe(original); expect(imageFileState(first).original).toBe(original);
    state.resize({mode: 'max-edge', maxEdge: 2048}); await state.images.ready();
    expect(process).toHaveBeenCalledTimes(2); expect(inputs).toEqual([String(original.size), String(original.size)]);
    expect(imageFileState(state.files[0]).original).toBe(original); state.images.destroy(); expect(state.disposed).not.toHaveBeenCalled();
});
it('does not revive a removed image when a non-cancellable decoder finishes', async () => {
    let finish!: (value: ImageOutput) => void, captured!: ImageSource;
    const state = fixture(async source => {captured = source; return new Promise(resolve => {finish = resolve;});});
    state.images.refresh(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    state.replace([]); finish(output(captured)); await state.images.ready(); expect(state.files).toEqual([]);
    expect(state.setFiles).not.toHaveBeenCalled(); state.images.destroy();
});
it('keeps the original group intact when one image fails and makes failure visible', async () => {
    const state = fixture(async source => {if (source.name === 'bad.png') throw new Error('encode-failed'); return output(source);});
    const originals = [...state.files, new File(['bad'], 'bad.png', {type: 'image/png'})]; state.replace(originals);
    await expect(state.images.ready()).rejects.toThrow('encode-failed'); expect(state.files).toEqual(originals);
    expect(state.images.busy).toBe(true); expect(state.setFiles).not.toHaveBeenCalled(); state.images.destroy();
});

it('publishes an invalid policy once and allows rendering to observe it without recursive work', () => {
    let images!: ImageAttachments, invalid = true, notifications = 0;
    images = new ImageAttachments({getFiles: () => [new File(['x'], 'photo.png', {type: 'image/png'})], setFiles: () => {},
        getResize: () => {if (invalid) throw new Error('invalid-policy'); return {mode: 'original'};},
        changed: () => {notifications++; images.refresh();}});
    expect(() => images.refresh()).not.toThrow(); expect(notifications).toBe(1);
    expect(images.error).toBeInstanceOf(Error); images.refresh(); expect(notifications).toBe(1);
    invalid = false; images.destroy();
});

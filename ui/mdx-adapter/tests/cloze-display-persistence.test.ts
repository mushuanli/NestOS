// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend, type IFileSystem} from '@itookit/vfs-core';
import {defaultEditorFactory} from '../src/factory';
import {SeqFileStore} from '../src/srs-store';

beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    Object.defineProperty(Range.prototype, 'getClientRects', {configurable: true, value: () => []});
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {configurable: true, value: () => new DOMRect()});
});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren();});
async function mount(fs: IFileSystem) {
    const element = document.createElement('div'); document.body.append(element);
    const editor = await defaultEditorFactory(element, {target: {kind: 'file', path: '/display.mind'},
        contentFormat: 'markdown', initialContent: '--alpha--', plugins: ['cloze:cloze'], files: {fs},
        hostContext: {saveContent: async () => {}, toggleSidebar() {}, navigate: async () => {}}});
    return {element, editor, card: element.querySelector<HTMLElement>('.mdx-cloze')!};
}
it.each(['open', 'hidden'] as const)('persists %s through the host seqfile and a fresh editor without writing grades', async mode => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    await fs.driver.createFile({parentPath: '/', name: 'display.mind', content: '--alpha--'});
    const store = new SeqFileStore(fs, '/display.mind'), first = await mount(fs);
    try {
        first.card.click(); first.card.querySelector<HTMLButtonElement>(`[data-display="${mode}"]`)!.click();
        await vi.waitFor(() => expect(first.card.dataset.clozeDisplay).toBe(mode));
        expect(await store.get('display:' + first.card.dataset.clozeLocator)).toEqual({v: 1, mode});
        expect(await store.entries('card:')).toEqual([]);
    } finally {await first.editor.destroy(); first.element.remove();}
    const second = await mount(fs);
    try {
        expect(second.card.dataset.clozeDisplay).toBe(mode);
        expect(second.card.classList.contains('hidden')).toBe(mode === 'hidden');
        second.card.click(); second.card.querySelector<HTMLButtonElement>('[data-display="normal"]')!.click();
        await vi.waitFor(() => expect(second.card.dataset.clozeDisplay).toBe('normal'));
        expect(await store.entries('display:')).toEqual([]); expect(await store.entries('card:')).toEqual([]);
        expect(new TextDecoder().decode(await fs.driver.readContent('/display.mind', {encoding: 'binary'}))).toBe('--alpha--');
    } finally {await second.editor.destroy(); store.destroy(); await manager.dispose();}
});

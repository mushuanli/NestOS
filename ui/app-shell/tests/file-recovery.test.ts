import {createEditorSwapFactory} from '../src/browser/editor-swap';
// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {createRecoverableFileEditor} from '../src/browser/file-recovery';
import {FileRecoveryStore} from '../src/persistence/file-recovery-store';
import {t} from '@itookit/common';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const release of cleanup.splice(0)) await release(); document.body.replaceChildren(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

async function file(original = 'Server content', path = '/note.md') {
    const mount = document.createElement('div'); document.body.append(mount);
    const events = new Map<string, Set<() => void>>(); let text = original, saved = original;
    const emit = (type: string) => events.get(type)?.forEach(listener => listener());
    const factory = vi.fn(async () => ({
        on(type: string, listener: () => void) {if (!events.has(type)) events.set(type, new Set()); events.get(type)!.add(listener); return () => events.get(type)!.delete(listener);},
        getText: () => text, setText: (next: string) => {text = next; emit('change');}, isDirty: () => text !== saved,
        setReadOnly: vi.fn(), updateNodeId: vi.fn(), destroy: vi.fn(async () => {}),
    }));
    const editor = await createRecoverableFileEditor(factory as never, mount, {target: {kind: 'file', path}, initialContent: original}, 'documents');
    cleanup.push(() => editor.destroy());
    return {editor, mount, emit, factory, saved() {saved = text; emit('saved');}, store: new FileRecoveryStore('documents', path)};
}

it.each(['missing', 'throws'])('stores recovery drafts when native randomUUID %s over HTTP', async native => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto),
        randomUUID: native === 'missing' ? undefined : () => {throw new Error('Unavailable in this context');} });
    const f = await file();
    expect(f.mount.querySelector('[data-file-recovery-error]')).toBeNull();
    expect(sessionStorage.getItem('mindos.file-recovery.tab')).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    f.editor.setText('HTTP draft');
    await vi.waitFor(async () => expect((await f.store.read())?.text).toBe('HTTP draft'));
    expect(f.mount.querySelector('[data-file-recovery-error]')).toBeNull();
    const next = await file(); expect(next.editor.getText()).toBe('HTTP draft');
});

it('retains unsaved edits through a failed save and restores them after rebuilding the page', async () => {
    const first = await file(); first.editor.setText('Offline edits'); first.emit('saveError');
    await vi.waitFor(async () => expect((await first.store.read())?.text).toBe('Offline edits'));
    await first.editor.destroy();
    const second = await file(); expect(second.editor.getText()).toBe('Offline edits'); expect(second.editor.isDirty()).toBe(true);
    second.saved(); await vi.waitFor(async () => expect(await second.store.read()).toBeUndefined());
});

it('preserves a conflicting draft as a separate read-only copy without overwriting the server file', async () => {
    const first = await file(); first.editor.setText('My unsaved edits');
    await vi.waitFor(async () => expect((await first.store.read())?.text).toBe('My unsaved edits'));
    const second = await file('Changed on the server');
    expect(second.editor.getText()).toBe('Changed on the server'); expect(second.editor.setReadOnly).toHaveBeenCalledWith(true);
    expect(second.mount.querySelector('textarea')?.value).toBe('My unsaved edits');
    expect((await second.store.read())?.text).toBe('My unsaved edits');
});

it('recognizes a successful save whose response was lost and does not restore or resend it', async () => {
    const first = await file(); first.editor.setText('Already persisted');
    await vi.waitFor(async () => expect((await first.store.read())?.text).toBe('Already persisted'));
    const second = await file('Already persisted'); expect(second.editor.getText()).toBe('Already persisted');
    expect(second.editor.isDirty()).toBe(false); await vi.waitFor(async () => expect(await second.store.read()).toBeUndefined());
});

it('moves recovery identity with the file instead of leaving its edits under the old name', async () => {
    const first = await file(); first.editor.setText('Rename without losing edits'); first.editor.updateNodeId!('/renamed.md');
    const renamed = new FileRecoveryStore('documents', '/renamed.md');
    await vi.waitFor(async () => expect((await renamed.read())?.text).toBe('Rename without losing edits'));
    await vi.waitFor(async () => expect(await first.store.read()).toBeUndefined());
});

it('keeps large documents in IndexedDB and isolates recovery copies between tabs and namespaces', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const value = {base: 'hash', text: '大'.repeat(600_000)}, store = new FileRecoveryStore('project-one', '/large.txt');
    await store.write(value); expect(await store.read()).toEqual(value);
    expect(await new FileRecoveryStore('project-two', '/large.txt').read()).toBeUndefined();
    sessionStorage.setItem('mindos.file-recovery.tab', 'another-tab');
    expect(await new FileRecoveryStore('project-one', '/large.txt').read()).toBeUndefined();
    await store.clear(); expect(await store.read()).toBeUndefined();
});

it('keeps the editor intact and prevents an unprotected reload when both browser stores fail', async () => {
    const f = await file(); vi.stubGlobal('sessionStorage', {getItem: () => null, removeItem() {}, clear() {}, setItem() {throw new Error('Quota');}});
    vi.stubGlobal('indexedDB', undefined); f.editor.setText('Keep this text');
    await vi.waitFor(() => expect(f.mount.textContent).toContain(t('fileRecovery.unavailable')));
    const reload = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(true); expect(f.editor.getText()).toBe('Keep this text'); expect(f.editor.isDirty()).toBe(true);
});

it('advances the recovery base after an acknowledged save so later offline edits restore cleanly', async () => {
    const first = await file(); first.editor.setText('Saved edit'); first.saved();
    await vi.waitFor(async () => expect(await first.store.read()).toBeUndefined());
    first.editor.setText('Next offline edit');
    await vi.waitFor(async () => expect((await first.store.read())?.text).toBe('Next offline edit'));
    const next = await file('Saved edit'); expect(next.editor.getText()).toBe('Next offline edit');
    expect(next.mount.querySelector('.file-recovery')).toBeNull();
});

it('keeps the HTTP swap separate from the active recovery draft and retains its file identity on rename', async () => {
    let configured: any, backup = ''; const events = new Map<string, () => void>();
    const closeSwap = vi.fn(async () => {}), openEditorSwap = vi.fn(async () => ({writeSwap: async (content: string) => {backup = content;},
        readSwap: async () => ({content: backup, savedAt: 1}), clearSwap: async () => {backup = '';}, closeSwap}));
    const factory = vi.fn(async (_mount, options) => {configured = options; return {on: (name, changed) => {events.set(name, changed); return () => {};},
        getText: () => 'Loaded', setText() {}, isDirty: () => false, destroy: async () => {}, updateNodeId() {}};});
    const wrapped = createEditorSwapFactory(factory as never, {editorSwaps: {openEditorSwap}} as never);
    const editor = await createRecoverableFileEditor(wrapped, document.createElement('div'), {target: {kind: 'file', path: '/old.md'}, initialContent: 'Loaded',
        files: {fs: {}}, hostContext: {reloadContent: async () => {}}} as any, 'documents'); cleanup.push(() => editor.destroy());
    await configured.hostContext.reloadRecovery.preserve('Unsaved before refresh'); events.get('contentLoaded')!();
    expect(await configured.hostContext.reloadRecovery.read()).toEqual({content: 'Unsaved before refresh', savedAt: 1});
    expect(await new FileRecoveryStore('documents', '/old.md').read()).toBeUndefined();
    editor.updateNodeId!('/new.md'); await configured.hostContext.reloadRecovery.preserve('Another draft');
    expect(backup).toBe('Another draft'); expect(openEditorSwap).toHaveBeenCalledOnce();
    expect(openEditorSwap).toHaveBeenCalledWith({files: {}, path: '/old.md'});
    await editor.destroy(); expect(closeSwap).toHaveBeenCalledOnce();
});

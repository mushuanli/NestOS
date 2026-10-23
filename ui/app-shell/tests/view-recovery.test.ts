// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {ChatInput} from '../../llm-ui-adapter/src/components/input/ChatInputView';
import {WorkbenchTabs} from '../src/workbench/tabs';
import {createRecoverableFileEditor} from '../src/browser/file-recovery';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close(); document.body.replaceChildren(); sessionStorage.clear(); vi.unstubAllGlobals();});
function composer() {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {fn(0); return 0;});
    const root = document.createElement('div'); document.body.append(root);
    const changed = vi.fn(), send = vi.fn(), input = new ChatInput(root, {onSend: send, onStop: vi.fn(), onDraftChange: changed});
    cleanups.push(() => input.destroy()); return {root, input, changed, send};
}

it('restores programmatic composer text, selection and attachments without submitting or saving it', () => {
    const old = composer(), next = composer();
    old.input.setConfig({text: 'Inserted by a Flow', settings: {connectionId: 'chosen', modelTier: 'fast'}});
    const file = new File(['file bytes'], 'note.txt', {type: 'text/plain'});
    old.input.restoreDraft('Inserted by a Flow', [file], 'default');
    const textarea = old.root.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!; textarea.setSelectionRange(3, 7);
    next.input.restoreDraft('Saved draft', [file, new File(['old'], 'old.txt')], 'default');
    next.changed.mockClear(); next.send.mockClear();
    next.input.restoreRecovery(old.input.captureRecovery());
    expect(next.input.getConfig()).toMatchObject({text: 'Inserted by a Flow', settings: {connectionId: 'chosen', modelTier: 'fast'}});
    expect(next.input.getDraftFiles()).toEqual([file]);
    expect(next.root.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.selectionStart).toBe(3);
    expect(next.changed).not.toHaveBeenCalled(); expect(next.send).not.toHaveBeenCalled();
});

it('keeps independent snapshots for hidden tabs and follows renamed tab identities', async () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {fn(0); return 0;});
    const actions = {activate: vi.fn(async () => {}), dispose: vi.fn(async () => {}), empty: vi.fn(), error: vi.fn()};
    const root = document.createElement('div'); document.body.append(root);
    const tabs = new WorkbenchTabs(root, actions); cleanups.push(() => tabs.destroy());
    const one = await tabs.open('/one', 'One', false), two = await tabs.open('/two', 'Two', false);
    const editor = (text: string) => ({captureRecovery: () => ({text}), restoreRecovery: vi.fn(), suspendForRecovery: vi.fn(), on: () => () => {}});
    tabs.bind(one, editor('draft one') as never); tabs.bind(two, editor('draft two') as never);
    tabs.rename('/one', '/renamed', 'Renamed');
    const state = tabs.captureRecovery(); tabs.suspendForRecovery();
    const nextRoot = document.createElement('div'); document.body.append(nextRoot);
    const next = new WorkbenchTabs(nextRoot, actions); cleanups.push(() => next.destroy()); next.restoreRecovery(state);
    const restored = editor(''); next.bind(next.get('/renamed')!, restored as never);
    expect(restored.restoreRecovery).toHaveBeenCalledExactlyOnceWith({text: 'draft one'});
    next.rename('/two', '/renamed-two', 'Renamed two');
    expect(next.captureRecovery().editors.get('/renamed-two')?.data).toEqual({text: 'draft two'});
});

it('restores snapshots that arrive after the editor has already mounted', async () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {fn(0); return 0;});
    const root = document.createElement('div'); document.body.append(root);
    const tabs = new WorkbenchTabs(root, {activate: vi.fn(async () => {}), dispose: vi.fn(async () => {}), empty: vi.fn(), error: vi.fn()});
    cleanups.push(() => tabs.destroy());
    const tab = await tabs.open('/connections/c', 'Connection', false), restoreRecovery = vi.fn();
    tabs.bind(tab, {restoreRecovery, on: () => () => {}} as never);
    tabs.restoreRecovery({tabs: [{id: tab.id, title: tab.title}], editors: new Map([[tab.id, {data: {name: 'Pending draft'}, scroll: []}]])});
    expect(restoreRecovery).toHaveBeenCalledExactlyOnceWith({name: 'Pending draft'});
    expect(() => tabs.assertRecovery()).not.toThrow();
});

it('distinguishes an unfinished mount from the actual editor restoration failure', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const tabs = new WorkbenchTabs(root, {activate: vi.fn(async () => {}), dispose: vi.fn(async () => {}), empty: vi.fn(), error: vi.fn()});
    cleanups.push(() => tabs.destroy());
    const tab = await tabs.open('/connections/c', 'Connection', false);
    tabs.restoreRecovery({tabs: [{id: tab.id, title: tab.title}], editors: new Map([[tab.id, {data: {name: 'Pending draft'}, scroll: []}]])});
    expect(() => tabs.assertRecovery()).toThrowError(expect.objectContaining({code: 'RECOVERY_RESTORE_INCOMPLETE'}));
    const failure = Object.assign(new Error('Form fields changed'), {code: 'RECOVERY_FORM_CHANGED'});
    expect(() => tabs.bind(tab, {restoreRecovery: () => {throw failure;}} as never)).toThrow(failure);
    expect(() => tabs.assertRecovery()).toThrow(failure);
    expect(tabs.captureRecovery().editors.get(tab.id)?.data).toEqual({name: 'Pending draft'});
});

it('restores an in-memory file checkpoint and retains a copy when server content changed', async () => {
    const build = async (original: string) => {
        const panel = document.createElement('div'); document.body.append(panel); let text = original;
        const factory = async () => ({getText: () => text, getMode: () => 'edit', setText: (value: string) => {text = value;},
            setDirty: vi.fn(), isDirty: () => true, setReadOnly: vi.fn(), on: () => () => {}, destroy: async () => {}, switchToMode: async () => {}});
        const editor = await createRecoverableFileEditor(factory as never, panel, {target: {kind: 'file', path: '/note.md'}, initialContent: original}, 'notes');
        cleanups.push(() => editor.destroy()); return {editor, panel};
    };
    const previous = await build('original'); previous.editor.setText('unsaved');
    const state = previous.editor.captureRecovery!(), next = await build('original');
    next.editor.restoreRecovery!(state); expect(next.editor.getText()).toBe('unsaved');
    const conflict = await build('changed elsewhere'); conflict.editor.restoreRecovery!(state);
    expect(conflict.editor.getText()).toBe('changed elsewhere');
    expect(conflict.panel.querySelector<HTMLTextAreaElement>('.file-recovery textarea')?.value).toBe('unsaved');
    const recoveredConflict = await build('changed elsewhere'); recoveredConflict.editor.restoreRecovery!(conflict.editor.captureRecovery!());
    expect(recoveredConflict.editor.getText()).toBe('changed elsewhere');
    expect(recoveredConflict.panel.querySelector<HTMLTextAreaElement>('.file-recovery textarea')?.value).toBe('unsaved');
});

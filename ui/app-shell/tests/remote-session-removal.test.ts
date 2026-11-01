// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {remoteSessionPath} from '@itookit/app-contracts';
import {t} from '@itookit/common';
import {confirmRemoteRemoval, remoteRemovalItems, type RemoteRemovalItem} from '../src/projects/remote-session-removal';
import {nativeSessionMenu} from '../src/projects/remote-session-management';

const methods = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
    for (const method of ['showModal', 'close']) {
        methods.set(method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method));
        Object.defineProperty(HTMLDialogElement.prototype, method, {configurable: true, value: vi.fn()});
    }
});
afterEach(() => {
    document.body.replaceChildren(); vi.restoreAllMocks();
    for (const [method, descriptor] of methods) {
        if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
        else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    }
});
const signal = () => new AbortController().signal;
const item = (id: string, capability: RemoteRemovalItem['capability'] = {delete: true}): RemoteRemovalItem => ({id,
    target: {kind: 'remote', folder: '/P', profileId: 'dsh', nativeSessionId: id}, capability});
const submit = () => document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
const cancel = () => document.querySelector<HTMLButtonElement>('dialog button[type=button]')!.click();

it.each([{delete: true}, {archive: true}])('confirms native removal and cancels without mutating: %j', async capability => {
    const apply = vi.fn(), pending = confirmRemoteRemoval([item('a', capability), item('b', capability)], signal(), apply);
    expect(document.querySelector('dialog')).not.toBeNull();
    expect(apply).not.toHaveBeenCalled(); cancel(); await pending; expect(apply).not.toHaveBeenCalled();
});
it('offers archiving without invoking deletion when the native profile cannot delete', async () => {
    const apply = vi.fn(async () => {}), rows = [item('a', {archive: true}), item('b', {archive: true})];
    const pending = confirmRemoteRemoval(rows, signal(), apply);
    expect(document.querySelector('dialog')?.textContent).toContain(t('harness.deleteToArchivePrompt', {count: '2'}));
    expect(apply).not.toHaveBeenCalled(); submit(); await pending;
    expect(apply.mock.calls).toEqual([[rows[0], {kind: 'archive'}], [rows[1], {kind: 'archive'}]]);
});
it('reports unavailable sessions and never silently archives a busy selection', async () => {
    const apply = vi.fn();
    await expect(confirmRemoteRemoval([item('busy', {archive: true, archiveDisabled: true})], signal(), apply)).rejects.toThrow(t('harness.removalUnavailable'));
    expect(document.querySelector('dialog')).toBeNull(); expect(apply).not.toHaveBeenCalled();
});
it('retains confirmed progress when a later item fails and the user retries', async () => {
    const rows = [item('a'), item('b')], apply = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Specific failure')).mockResolvedValue(undefined);
    const pending = confirmRemoteRemoval(rows, signal(), apply); submit();
    await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toBe('Specific failure'));
    expect(document.querySelector('dialog')).not.toBeNull(); submit(); await pending;
    expect(apply.mock.calls.map(call => call[0].id)).toEqual(['a', 'b', 'b']);
});
it('keeps read-only navigation projections eligible for host-owned management', () => {
    const path = remoteSessionPath('/P', 'dsh', 'a');
    expect(remoteRemovalItems([{id: path, metadata: {custom: {_readOnly: true, nativeManagement: {archive: true}}}}]))
        .toMatchObject([{target: {nativeSessionId: 'a'}, capability: {archive: true}}]);
    expect(remoteRemovalItems([{id: '/s', metadata: {custom: {}}}])).toBeUndefined();
});
it('uses the same archive fallback confirmation from the single-session delete menu', async () => {
    const manage = vi.fn(async () => ({title: 'A', deletedSessionIds: []})), changed = vi.fn(async () => {}), report = vi.fn();
    const menu = nativeSessionMenu(manage as any, item('a').target, 'A', {archive: true}, signal(), async () => {}, changed, report);
    menu.find(entry => entry.id === 'native-delete')!.onClick();
    expect(document.querySelector('dialog')?.textContent).toContain(t('harness.deleteToArchivePrompt', {count: '1'}));
    expect(manage).not.toHaveBeenCalled(); submit();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(manage).toHaveBeenCalledWith('/P', 'dsh', 'a', {kind: 'archive'}, expect.anything()); expect(report).not.toHaveBeenCalled();
});

it('executes native deletion only after confirmation when every selected session supports it', async () => {
    const apply = vi.fn(async () => {}), rows = [item('a'), item('b')];
    const pending = confirmRemoteRemoval(rows, signal(), apply);
    expect(document.querySelector('dialog')?.textContent).toContain(t('harness.bulkDeletePrompt', {count: '2'}));
    expect(apply).not.toHaveBeenCalled(); submit(); await pending;
    expect(apply.mock.calls).toEqual([[rows[0], {kind: 'delete'}], [rows[1], {kind: 'delete'}]]);
});

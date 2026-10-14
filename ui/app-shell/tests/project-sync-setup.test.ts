// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { showProjectSyncSetup } from '../src/projects/sync/setup';

const descriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
    for (const method of ['showModal', 'close']) {
        descriptors.set(method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method));
        Object.defineProperty(HTMLDialogElement.prototype, method, { configurable: true, value: vi.fn() });
    }
});
afterEach(() => {
    document.body.replaceChildren();
    for (const [method, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
        else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    }
});
function button(key: Parameters<typeof t>[0]): HTMLButtonElement {
    return [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b => b.textContent === t(key))!;
}
function ports() {
    return { connections: () => [{ id: 'server', name: 'Saved server' }, { id: 'other', name: 'Other server' }],
        inspect: vi.fn(async () => [{ projectId: 'existing' }]), bind: vi.fn(async () => {}) };
}
it.each([true, false])('selects an existing sync directory or creates a new one (create=%s)', async create => {
    const host = ports(), controller = new AbortController(), closed = showProjectSyncSetup(host, 'new-project', controller.signal);
    expect(button('project.sync.bindConfirm').disabled).toBe(true); button('project.sync.loadProjects').click();
    await vi.waitFor(() => expect(button('project.sync.bindConfirm').disabled).toBe(false));
    const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${t('project.sync.cloudProject')}"]`)!;
    expect([...select.options].map(o => o.value)).toEqual(['', 'existing']);
    select.value = create ? '' : 'existing'; button('project.sync.bindConfirm').click(); await closed;
    expect(host.bind).toHaveBeenCalledWith('server', create ? 'new-project' : 'existing', create, 'both');
    expect(document.querySelector('dialog')).toBeNull();
});
it('invalidates the directory selection when changing servers and preserves an error without binding', async () => {
    const host = ports(), controller = new AbortController(), closed = showProjectSyncSetup(host, 'new-project', controller.signal);
    button('project.sync.loadProjects').click(); await vi.waitFor(() => expect(button('project.sync.bindConfirm').disabled).toBe(false));
    const server = document.querySelector<HTMLSelectElement>(`select[aria-label="${t('remote.connection')}"]`)!;
    host.inspect.mockRejectedValue(new Error('sync disabled'));
    server.value = 'other'; server.dispatchEvent(new Event('change')); expect(button('project.sync.bindConfirm').disabled).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe('sync disabled'));
    expect(button('project.sync.bindConfirm').disabled).toBe(true); expect(host.bind).not.toHaveBeenCalled(); controller.abort(); await closed;
});
it('allows cancelling setup without creating a binding', async () => {
    const host = ports(), controller = new AbortController(), closed = showProjectSyncSetup(host, 'new-project', controller.signal);
    button('project.cancel').click(); await closed; expect(host.bind).not.toHaveBeenCalled();
});

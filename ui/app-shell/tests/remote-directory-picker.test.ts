// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import type { ProjectService } from '@itookit/app-core';
import { t } from '@itookit/common';
import { remoteDirectoryPicker } from '../src/files/remote-directory-picker';
import { remoteProjectFields } from '../src/files/remote-project-fields';

it('ignores stale directory responses after switching connections or closing', async () => {
    let finish!: (value: { paths: string[]; nextCursor: null }) => void;
    const browse = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
        .mockResolvedValue({ paths: ['/second'], nextCursor: null });
    const projects = { remoteMounts: { browseDirectories: browse } } as unknown as ProjectService;
    const parent = document.createElement('div'), path = document.createElement('input'), connection = document.createElement('select');
    connection.append(new Option('One', 'one'), new Option('Two', 'two'));
    const controller = new AbortController();
    const picker = remoteDirectoryPicker(projects, parent, connection, path, controller.signal);
    picker.reset(); connection.value = 'two'; picker.reset();
    await vi.waitFor(() => expect(parent.textContent).toContain('/second'));
    finish({ paths: ['/stale'], nextCursor: null }); await Promise.resolve();
    expect(parent.textContent).not.toContain('/stale');
    Array.from(parent.querySelectorAll('button')).find(item => item.textContent === '/second')!.click();
    expect(path.value).toBe('/second'); controller.abort();
    expect(browse.mock.calls.at(-1)![3].signal.aborted).toBe(true);
});

it('disables unreachable connections and restores their selection after a successful recheck', async () => {
    let online = false;
    const browse = vi.fn(async (id: string) => {
        if (id === 'down' && !online) throw { code: 'EIO', operation: 'connect' };
        return { paths: ['/docs'], nextCursor: null };
    });
    const projects = { remoteMounts: { connections: () => [{ id: 'down', name: 'Offline' }, { id: 'up', name: 'Online' }], browseDirectories: browse } } as unknown as ProjectService;
    const parent = document.createElement('div'), controller = new AbortController();
    const fields = remoteProjectFields(projects, parent, document.createElement('div'), controller.signal);
    const type = parent.querySelector('select')!; type.value = 'remote'; type.dispatchEvent(new Event('change'));
    expect(fields.connection.disabled).toBe(true);
    await vi.waitFor(() => expect(fields.connection.disabled).toBe(false));
    const down = fields.connection.querySelector<HTMLOptionElement>('[value="down"]')!;
    expect(down.disabled).toBe(true);
    expect(down.textContent).toContain(t('remote.state.offline'));
    expect(parent.textContent).toContain(t('remote.error.network'));
    fields.connection.value = 'up'; fields.connection.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(parent.textContent).toContain('/docs'));
    expect(browse).toHaveBeenCalledTimes(2);
    online = true;
    Array.from(parent.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === t('remote.recheck'))!.click();
    await vi.waitFor(() => expect(down.disabled).toBe(false));
    expect(fields.connection.value).toBe('');
    fields.connection.value = 'down'; fields.connection.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(parent.textContent).toContain('/docs'));
    controller.abort();
});

it('renders navigation as accessible icons and keeps the connection placeholder as translated text', () => {
    const projects = { remoteMounts: { connections: () => [] } } as unknown as ProjectService;
    const parent = document.createElement('div');
    remoteProjectFields(projects, parent, document.createElement('div'), new AbortController().signal);
    for (const label of ['导出目录', '上一级', '浏览此路径', '重新检查']) {
        const button = parent.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
        expect(button).not.toBeNull(); expect(button.title).toBe(label);
        expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
        expect(button.textContent).toBe('');
    }
    expect(parent.textContent).toContain('请选择可用的远程文件系统');
    expect(parent.textContent).not.toMatch(/remote\./);
});

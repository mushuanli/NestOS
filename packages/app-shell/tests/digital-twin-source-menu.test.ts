// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { DigitalTwinService, folderBrowserPath, remoteSessionPath, type ProjectService } from '@itookit/app-core';
import type { VFSNodeUI } from '@itookit/vfs-ui';
import { sha256HexSync } from '@itookit/llm-context';
import { t } from '@itookit/common';
import { showTwinSource } from '../src/digital-twin/source-dialog';
import { projectTwinTarget } from '../src/digital-twin/source-menu';

it('shows extracted information and removes it while keeping the raw source', async () => {
    const old = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const source = { kind: 'file' as const, projectId: 'p', target: 'note.md', path: 'note.md', label: '<img src=x>' };
    const service = new DigitalTwinService({ fs: await manager.openFileSystem('/'), defaultConnection: async () => 'model',
        reader: { sessions: async () => [], discover: async () => ({ resources: [source], projects: ['p'], completeScopes: ['p/file'], errors: [] }),
            read: async () => ({ text: 'Alice prefers tea', hash: sha256HexSync('Alice prefers tea'), nativeIdentity: 'note' }) },
        extractor: { run: async (_job, _text, attached) => { await attached('task'); return { tokens: 10,
            candidates: [{ kind: 'preference', subject: 'self', content: 'Alice prefers tea', quote: 'Alice prefers tea', project: '', eventTime: '' }] }; },
            cleanup: async () => {}, cancel: async () => {} }, deleteSession: vi.fn() });
    const abort = new AbortController();
    try {
        showTwinSource(service, source, vi.fn(), abort.signal);
        const dialog = document.querySelector('dialog')!;
        await vi.waitFor(() => expect(dialog.textContent).toContain(t('twin.selectionAbsent')));
        expect(dialog.querySelector('img')).toBeNull();
        const button = (text: string) => [...dialog.querySelectorAll('button')].find(button => button.textContent === text)!;
        button(t('twin.addAndScan')).click();
        await vi.waitFor(() => expect(dialog.querySelector('blockquote')?.textContent).toBe('Alice prefers tea'));
        button(t('twin.analysisEdit')).click();
        const content = dialog.querySelector<HTMLTextAreaElement>('textarea[name=content]')!;
        content.value = 'Alice prefers coffee';
        const currentSettings = (await service.snapshot()).settings;
        await service.configure({ userName: 'Alice' }, currentSettings.revision);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(dialog.querySelector('textarea')).toBe(content);
        expect(content.value).toBe('Alice prefers coffee');
        const review = vi.spyOn(service, 'review').mockRejectedValueOnce(new Error('TWIN_REVIEW_CONFLICT'));
        button(t('twin.save')).click();
        await vi.waitFor(() => expect(dialog.querySelector('[role=alert]')?.textContent).toContain('TWIN_REVIEW_CONFLICT'));
        expect(content.value).toBe('Alice prefers coffee');
        button(t('twin.save')).click();
        await vi.waitFor(() => expect(dialog.querySelector('textarea')).toBeNull());
        expect(review).toHaveBeenCalledTimes(2);
        expect(dialog.textContent).toContain('Alice prefers coffee');
        expect(dialog.textContent).toContain(t('twin.analysisEdited'));
        expect((await service.selectionInfo(source)).memories[0].data.content).toBe('Alice prefers coffee');
        button(t('twin.analysisEdit')).click();
        dialog.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Unsaved draft';
        button(t('twin.cancel')).click();
        await vi.waitFor(() => expect(dialog.querySelector('textarea')).toBeNull());
        expect(dialog.textContent).not.toContain('Unsaved draft');
        button(t('twin.removeSelection')).click();
        await vi.waitFor(() => expect(dialog.textContent).toContain(t('twin.selectionRemoved')));
        expect(dialog.querySelector('blockquote')).toBeNull(); expect((await service.snapshot()).memories).toHaveLength(0);
    } finally { abort.abort(); await service.dispose(); await manager.dispose(); if (old) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', old); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); }
    expect(document.querySelector('dialog')).toBeNull();
});
it('maps project directories and remote sessions to stable source identities', async () => {
    const projects = { forFolder: async () => ({ project: { id: 'p' } }) } as unknown as ProjectService;
    const node = (id: string, type = 'file') => ({ id, type, metadata: { title: 'Title', custom: {} } }) as VFSNodeUI;
    const prefix = folderBrowserPath('/Projects/Test');
    expect(await projectTwinTarget(projects, node(prefix + '/@files/docs', 'directory'))).toEqual({
        kind: 'file', target: 'project://p/docs', directory: true, label: 'Title' });
    expect(await projectTwinTarget(projects, node(remoteSessionPath('/Projects/Test', 'codex', 'remote-session')))).toEqual({
        kind: 'harness-session', target: '[\"p\",\"codex\",\"remote-session\"]', label: 'Title' });
    expect(await projectTwinTarget(projects, node('/session123'))).toEqual({ kind: 'session', target: 'session123', label: 'Title' });
});

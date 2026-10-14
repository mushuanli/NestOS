// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import type { ProjectService } from '@itookit/app-core';
import { FSError } from '@itookit/vfs-core';
import { openProjectFileEditor } from '../src/projects/project-file-editor';
import { ViewLoad } from '../src/lifecycle/view-load';

it.each([true, false])('opens a read-only bounded preview with known size=%s and never creates a writable editor', async known => {
    const readContent = vi.fn(async (_path, options) => {
        if (!options.length) throw new FSError('EFBIG', 'limit');
        return new TextEncoder().encode('preview text').buffer;
    });
    const dispose = vi.fn(async () => {});
    const projects = { openWorkspace: async () => ({ dispose, fs: { driver: {
        getNode: async () => ({ type: 'file', size: known ? 40 * 1024 * 1024 : undefined }), readContent,
    } } }) } as unknown as ProjectService;
    const mount = document.createElement('div'), factory = vi.fn(), binary = vi.fn();
    const opened = await openProjectFileEditor(projects, { folder: '/remote', path: '/workspace/large.log' }, new ViewLoad(new AbortController().signal), {
        factory, mount: async () => mount, showBinary: binary, deferCleanup() {}, changed() {}, host: {} as never,
    });
    expect(mount.textContent).toContain('仅预览前 256 KiB');
    expect(mount.querySelector('pre')!.textContent).toBe('preview text');
    expect(readContent).toHaveBeenLastCalledWith('/workspace/large.log', expect.objectContaining({ offset: 0, length: 256 * 1024 }));
    expect(readContent).toHaveBeenCalledTimes(known ? 1 : 2);
    expect(factory).not.toHaveBeenCalled(); expect(binary).not.toHaveBeenCalled();
    expect(opened?.editor).toBeUndefined(); opened?.previewCleanup?.(); await opened?.context.release();
    expect(dispose).toHaveBeenCalledOnce();
});

it('does not fetch a large known binary file', async () => {
    const readContent = vi.fn();
    const projects = { openWorkspace: async () => ({ dispose: async () => {}, fs: { driver: {
        getNode: async () => ({ type: 'file', size: 60 * 1024 * 1024 }), readContent,
    } } }) } as unknown as ProjectService;
    const mount = document.createElement('div');
    const opened = await openProjectFileEditor(projects, { folder: '/remote', path: '/workspace/large.pdf' }, new ViewLoad(new AbortController().signal), {
        factory: vi.fn(), mount: async () => mount, showBinary: vi.fn(), deferCleanup() {}, changed() {}, host: {} as never,
    });
    expect(mount.textContent).toContain('60.0 MiB'); expect(mount.textContent).toContain('无法内嵌预览');
    expect(readContent).not.toHaveBeenCalled(); await opened?.context.release();
});

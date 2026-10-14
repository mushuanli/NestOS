// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultEditorFactory } from '../src/factory';
import type { MDxEditor } from '@itookit/mdxeditor';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it('opens rendered document references using the current path after moving the editor', async () => {
    const mount = document.createElement('div'); document.body.append(mount);
    const openFile = vi.fn(async () => {});
    const editor = await defaultEditorFactory(mount, { target: { kind: 'file', path: '/docs/start.md' }, initialMode: 'render',
        initialContent: '[Next](../next.md#intro)\n\n[Local](#intro)\n\n# Intro',
        hostContext: { openFile, toggleSidebar() {}, navigate: async () => {} } }) as MDxEditor;
    try {
        const next = mount.querySelector<HTMLAnchorElement>('a[href="../next.md#intro"]')!;
        expect(next).not.toBeNull(); next.click();
        await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith('/next.md', 'intro'));
        editor.updateNodeId('/moved/deeper/start.md'); next.click();
        await vi.waitFor(() => expect(openFile).toHaveBeenLastCalledWith('/moved/next.md', 'intro'));
        const navigate = vi.spyOn(editor, 'navigateTo').mockResolvedValue(undefined);
        mount.querySelector<HTMLAnchorElement>('a[href="#intro"]')!.click();
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ elementId: 'intro' }));
        expect(openFile).toHaveBeenCalledTimes(2);
    } finally { await editor.destroy(); }
});

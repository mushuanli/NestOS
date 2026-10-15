// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { VfsJsonStore } from '../src/persistence/vfs-json-store';

afterEach(() => { vi.unstubAllGlobals(); document.documentElement.removeAttribute('data-theme'); });
it('reads and persists theme through the document port and releases its event listeners', async () => {
    const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', () => media);
    const { ThemeService, THEME_CHANGE_EVENT } = await import('../src/ThemeService');
    const readUiDocuments = vi.fn(async () => ({ theme: { mode: 'dark' } }));
    const writeUiDocuments = vi.fn(async () => {});
    const store = new VfsJsonStore({ readUiDocuments, writeUiDocuments }), theme = new ThemeService();
    const listenersBefore = media.addEventListener.mock.calls.length;
    try {
        await theme.init(store); expect(document.documentElement.dataset.theme).toBe('dark');
        expect(readUiDocuments).toHaveBeenCalledWith(['theme']);
        await theme.setMode('light'); expect(writeUiDocuments).toHaveBeenCalledWith({ theme: { mode: 'light' } });
        await theme.setMode('light'); expect(writeUiDocuments).toHaveBeenCalledOnce();
        theme.destroy();
        window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { mode: 'dark' } }));
        expect(document.documentElement.dataset.theme).toBe('light');
        await theme.init(store); expect(media.addEventListener).toHaveBeenCalledTimes(listenersBefore + 2);
    } finally { theme.destroy(); }
});

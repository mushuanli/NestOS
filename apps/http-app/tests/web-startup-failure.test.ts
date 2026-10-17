// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {openIndexedDBBackend} from '@itookit/vfsdriver-indexeddb';
import {createApplicationRuntime} from '@itookit/app-core';

vi.mock('@itookit/vfsdriver-indexeddb', async original => ({...await original<object>(), openIndexedDBBackend: vi.fn()}));
vi.mock('@itookit/app-core', async original => ({...await original<object>(), createApplicationRuntime: vi.fn()}));

beforeEach(async () => {
    vi.resetModules(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = new DOMParser().parseFromString(await readFile('../web-app/index.html', 'utf8'), 'text/html');
    document.body.replaceWith(document.importNode(html.body, true));
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
});
afterEach(() => {document.head.replaceChildren(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks();});

it.each(['storage', 'runtime'] as const)('shows a visible startup error when local %s initialization fails before initApp', async stage => {
    if (stage === 'storage') vi.mocked(openIndexedDBBackend).mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    else {
        vi.mocked(openIndexedDBBackend).mockResolvedValueOnce({storageAccess: () => ({})} as never);
        vi.mocked(createApplicationRuntime).mockRejectedValueOnce(new Error('Runtime unavailable'));
    }
    await import('../../web-app/src/main');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('unavailable'));
    expect(document.body.hasAttribute('data-app-starting')).toBe(false);
    expect(document.querySelector('.app-startup button')).not.toBeNull();
});

it('reports a stylesheet failure even while local storage initialization is still pending', async () => {
    let failStorage!: (error: Error) => void;
    vi.mocked(openIndexedDBBackend).mockImplementationOnce(() => new Promise((_resolve, reject) => {failStorage = reject;}));
    document.head.innerHTML = '<link rel="stylesheet" data-app-styles="error" href="/missing.css">';
    await import('../../web-app/src/main');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('stylesheet failed'));
    expect(document.body.hasAttribute('data-app-starting')).toBe(false);
    failStorage(new Error('Storage cancelled')); await Promise.resolve();
    expect(createApplicationRuntime).not.toHaveBeenCalled();
});

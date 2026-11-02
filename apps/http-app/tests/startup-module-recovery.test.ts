// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {startupModuleRecovery} from '../../web-app/src/startup-module-recovery';

const cleanups: Array<() => void> = [];
afterEach(() => {cleanups.splice(0).forEach(stop => stop()); document.head.replaceChildren(); document.body.replaceChildren();});
function fixture() {
    const reload = vi.fn(), fetcher = vi.fn(async () => new Response('export const ready = true;'));
    const recovery = startupModuleRecovery({reload, fetcher}); cleanups.push(recovery.dispose);
    return {reload, fetcher, recovery};
}
function failedModule(href: string) {
    const link = document.createElement('link'); link.rel = 'modulepreload'; link.href = href;
    document.head.append(link); link.dispatchEvent(new Event('error'));
}
it('replaces a failed same-origin preload before reloading and strips query parameters', async () => {
    const f = fixture(); failedModule('/assets/chat-abcdefgh.js?secret=hidden');
    await f.recovery.reload(true);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher).toHaveBeenCalledWith('/assets/chat-abcdefgh.js', expect.objectContaining({cache: 'reload', credentials: 'same-origin', redirect: 'error'}));
    expect(f.fetcher.mock.invocationCallOrder[0]).toBeLessThan(f.reload.mock.invocationCallOrder[0]);
    expect(f.reload).toHaveBeenCalledOnce();
});
it('retains the failure page when the replacement module is still unavailable', async () => {
    const f = fixture(); failedModule('/assets/chat-abcdefgh.js'); f.fetcher.mockResolvedValueOnce(new Response('unavailable', {status: 503}));
    await expect(f.recovery.reload(true)).rejects.toMatchObject({code: 'HTTP_503'}); expect(f.reload).not.toHaveBeenCalled();
    await f.recovery.reload(true); expect(f.reload).toHaveBeenCalledOnce();
});
it('reloads the current HTML when an old module has already been retired', async () => {
    const f = fixture(); failedModule('/assets/retired-abcdefgh.js'); f.fetcher.mockResolvedValueOnce(new Response('missing', {status: 404}));
    await f.recovery.reload(true); expect(f.reload).toHaveBeenCalledOnce();
});
it('never fetches other origins or user paths and releases its capture listener', async () => {
    const f = fixture(); failedModule('https://other.invalid/assets/chat-abcdefgh.js'); failedModule('/private/file.js');
    f.recovery.dispose(); failedModule('/assets/gone-abcdefgh.js'); document.head.replaceChildren();
    await f.recovery.reload(true); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.reload).toHaveBeenCalledOnce();
});
it('keeps normal reloads independent from module cache repair', async () => {
    const f = fixture(); failedModule('/assets/chat-abcdefgh.js');
    await f.recovery.reload(false); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.reload).toHaveBeenCalledOnce();
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { installHttpStatus } from '../src/client/status-banner';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); sessionStorage.clear(); vi.restoreAllMocks(); });

it.each(['expired', 'update'])('retains programmatically inserted drafts during %s recovery until manual reload', async state => {
    const fetcher = vi.fn(async () => Response.json({ready: true})), reload = vi.fn();
    dispose = installHttpStatus({fetcher, reload});
    const draft = document.createElement('textarea'); document.body.append(draft);
    draft.value = 'Flow output inserted without an input event';
    window.dispatchEvent(state === 'expired'
        ? new CustomEvent('mindos:http-disconnected', {detail: {state}}) : new Event('vite:preloadError', {cancelable: true}));
    await vi.waitFor(() => expect(document.querySelector('.http-status')?.textContent)
        .toContain(t(state === 'expired' ? 'httpApp.viewExpiredReady' : 'httpApp.recovered')));
    expect(reload).not.toHaveBeenCalled(); expect(draft.value).toBe('Flow output inserted without an input event');
    expect(document.querySelector<HTMLElement>('.http-status')?.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('.http-status button')!.click(); expect(reload).toHaveBeenCalledOnce();
});

it('shows update failures without probing or automatically reloading an unsent draft', async () => {
    const fetcher = vi.fn(), reload = vi.fn(), draft = document.createElement('textarea');
    draft.value = 'Unsent input'; document.body.append(draft);
    dispose = installHttpStatus({ fetcher, reload });
    window.dispatchEvent(new Event('mindos:http-view-error'));
    await Promise.resolve();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('httpApp.viewError'));
    expect(document.querySelector<HTMLElement>('[role="alert"]')?.hidden).toBe(false);
    expect(fetcher).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled(); expect(draft.value).toBe('Unsent input');
    document.querySelector<HTMLButtonElement>('.http-status button')!.click(); expect(reload).toHaveBeenCalledOnce();
});

it('continues to recover a real disconnection while retaining edited input', async () => {
    const fetcher = vi.fn(async () => Response.json({ ready: true })), reload = vi.fn();
    dispose = installHttpStatus({ fetcher, reload });
    document.dispatchEvent(new Event('input'));
    window.dispatchEvent(new Event('mindos:http-disconnected'));
    await vi.waitFor(() => expect(document.querySelector('.http-status')?.textContent).toContain(t('httpApp.recovered')));
    expect(fetcher).toHaveBeenCalledOnce(); expect(reload).not.toHaveBeenCalled();
});

it('reconnects a short interruption without probing health or reloading the page', () => {
    const fetcher = vi.fn(), reload = vi.fn(), retry = vi.fn();
    window.addEventListener('mindos:http-retry', retry, {once: true});
    dispose = installHttpStatus({fetcher, reload});
    window.dispatchEvent(new CustomEvent('mindos:http-disconnected', {detail: {state: 'reconnecting'}}));
    expect(document.querySelector<HTMLElement>('.http-status')?.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('.http-status button')!.click();
    expect(retry).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('mindos:http-reconnected'));
    expect(document.querySelector<HTMLElement>('.http-status')?.hidden).toBe(true);
});

it('upgrades a reconnecting notice to an expired view while preserving edited input', async () => {
    const fetcher = vi.fn(async () => Response.json({ready: true})), reload = vi.fn();
    dispose = installHttpStatus({fetcher, reload}); document.dispatchEvent(new Event('input'));
    window.dispatchEvent(new CustomEvent('mindos:http-disconnected', {detail: {state: 'reconnecting'}}));
    window.dispatchEvent(new CustomEvent('mindos:http-disconnected', {detail: {state: 'expired'}}));
    await vi.waitFor(() => expect(document.querySelector('.http-status')?.textContent).toContain(t('httpApp.viewExpiredReady')));
    expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('mindos:http-reconnected'));
    expect(document.querySelector<HTMLElement>('.http-status')?.hidden).toBe(false);
});

it('does not hide a view update error on a late reconnect or health response', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => {complete = resolve;})), reload = vi.fn();
    dispose = installHttpStatus({fetcher, reload});
    window.dispatchEvent(new CustomEvent('mindos:http-disconnected', {detail: {state: 'expired'}}));
    window.dispatchEvent(new Event('mindos:http-view-error'));
    complete(Response.json({ready: true})); await new Promise(resolve => setTimeout(resolve, 0));
    window.dispatchEvent(new Event('mindos:http-reconnected'));
    expect(document.querySelector('.http-status')?.textContent).toContain(t('httpApp.viewError'));
    expect(reload).not.toHaveBeenCalled();
});

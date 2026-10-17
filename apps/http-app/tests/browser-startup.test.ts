// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createStartupStatus, stylesReady} from 'mind-os/startup';

afterEach(() => {document.head.replaceChildren(); document.body.replaceChildren(); delete document.body.dataset.appStarting; vi.useRealTimers();});
function stylesheet() {
    document.head.innerHTML = '<link data-app-styles="loading" rel="stylesheet" href="/app.css" media="print">';
    return document.querySelector<HTMLLinkElement>('link[data-app-styles]')!;
}

it.each(['load', 'error'] as const)('observes a stylesheet %s recorded before the shell module was loaded', async event => {
    const link = stylesheet();
    link.dataset.appStyles = event === 'load' ? 'loaded' : 'error';
    if (event === 'load') await expect(stylesReady()).resolves.toBeUndefined();
    else await expect(stylesReady()).rejects.toThrow('Application stylesheet failed to load');
});

it.each(['load', 'error'] as const)('settles and removes both listeners when a pending stylesheet emits %s', async event => {
    vi.useFakeTimers(); const link = stylesheet(), remove = vi.spyOn(link, 'removeEventListener');
    const outcome = stylesReady().then(() => 'loaded', (error: Error) => error.message);
    link.dispatchEvent(new Event(event));
    expect(await outcome).toBe(event === 'load' ? 'loaded' : 'Application stylesheet failed to load');
    expect(remove).toHaveBeenCalledWith('load', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('error', expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
});

it('bounds an unresolved stylesheet and cleans pending siblings when another stylesheet fails', async () => {
    vi.useFakeTimers(); const first = stylesheet(), second = first.cloneNode(true) as HTMLLinkElement;
    document.head.append(second);
    const outcome = stylesReady().catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await outcome).toBe('Application stylesheet loading timed out'); expect(vi.getTimerCount()).toBe(0);
    const failed = stylesReady().catch((error: Error) => error.message);
    first.dispatchEvent(new Event('error'));
    expect(await failed).toBe('Application stylesheet failed to load'); expect(vi.getTimerCount()).toBe(0);
});

it('dismisses the skeleton and shows one visible retry action even when external CSS failed', () => {
    document.body.dataset.appStarting = ''; const startup = createStartupStatus();
    expect(document.querySelector('[role="status"]')).toBeNull();
    startup.fail(new Error('Storage unavailable')); startup.fail(new Error('Still unavailable'));
    expect(document.body.hasAttribute('data-app-starting')).toBe(false);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Still unavailable');
    expect(document.querySelectorAll('.app-startup button')).toHaveLength(1);
});

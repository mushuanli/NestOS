import {t} from '@itookit/common';

/** Observe results recorded by the HTML handlers, including failures before module loading. */
export async function stylesReady(): Promise<void> {
    const abort = new AbortController();
    try {
        const links = document.querySelectorAll<HTMLLinkElement>('link[data-app-styles]');
        await Promise.all([...links].map(link => waitForStyle(link, abort.signal)));
    } finally {abort.abort();}
}
function waitForStyle(link: HTMLLinkElement, signal: AbortSignal): Promise<void> {
    if (link.dataset.appStyles === 'error') return Promise.reject(new Error('Application stylesheet failed to load'));
    if (link.dataset.appStyles === 'loaded' || link.sheet) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const finish = (error?: unknown) => {
            clearTimeout(timer); link.removeEventListener('load', loaded); link.removeEventListener('error', failed);
            signal.removeEventListener('abort', aborted);
            if (error) reject(error); else resolve();
        };
        const loaded = () => finish(), failed = () => finish(new Error('Application stylesheet failed to load'));
        const aborted = () => finish(signal.reason);
        const timer = setTimeout(() => finish(new Error('Application stylesheet loading timed out')), 30000);
        link.addEventListener('load', loaded, {once: true}); link.addEventListener('error', failed, {once: true});
        signal.addEventListener('abort', aborted, {once: true});
    });
}

/** Normal startup is silent; both browser hosts use the same visible failure exit. */
export function createStartupStatus() {
    const panel = document.createElement('section'); panel.className = 'app-startup';
    panel.setAttribute('role', 'status'); panel.setAttribute('aria-live', 'polite');
    const title = document.createElement('h1'), detail = document.createElement('p');
    title.textContent = t('httpApp.starting'); panel.append(title, detail);
    const reload = document.createElement('button'); reload.type = 'button';
    reload.textContent = t('httpApp.reload'); reload.onclick = () => location.reload();
    return {
        progress(message: string): void {detail.textContent = message;},
        ready(): void {panel.remove();},
        fail(error: unknown): void {
            delete document.body.dataset.appStarting;
            panel.setAttribute('role', 'alert'); title.textContent = t('httpApp.startupFailed');
            detail.textContent = error instanceof Error ? error.message : String(error);
            panel.append(reload); document.body.append(panel);
        },
    };
}

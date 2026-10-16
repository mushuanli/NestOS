import { t } from '@itookit/common';
import { ConnectionRecovery } from './connection-recovery';

/** Rebuild lost view capabilities while keeping potentially unsaved input in place. */
export function installHttpStatus(options: { fetcher?: typeof fetch; reload?: () => void } = {}): () => void {
    const abort = new AbortController(), banner = document.createElement('aside'); banner.className = 'http-status';
    banner.setAttribute('role', 'alert'); banner.hidden = true;
    const text = document.createElement('span'), action = document.createElement('button');
    const reload = options.reload ?? (() => location.reload()); let edited = false;
    const recovery = new ConnectionRecovery(signal => checkReadiness(options.fetcher ?? globalThis.fetch, signal), () => {
        text.textContent = t('httpApp.recovered');
        if (!edited && claimAutomaticReload()) reload();
    });
    action.type = 'button'; action.textContent = t('httpApp.reload'); action.onclick = reload;
    banner.append(text, action); document.body.append(banner);
    const show = (message: string) => {
        if (!banner.hidden) return;
        banner.hidden = false; text.textContent = message; recovery.start();
    };
    document.addEventListener('input', () => { edited = true; }, { capture: true, signal: abort.signal });
    document.addEventListener('change', () => { edited = true; }, { capture: true, signal: abort.signal });
    window.addEventListener('mindos:http-disconnected', () => show(t('httpApp.disconnected')), { signal: abort.signal });
    window.addEventListener('vite:preloadError', event => { event.preventDefault(); show(t('httpApp.updated')); }, { signal: abort.signal });
    window.addEventListener('online', () => recovery.retry(), { signal: abort.signal });
    window.addEventListener('focus', () => recovery.retry(), { signal: abort.signal });
    return () => { abort.abort(); recovery.stop(); banner.remove(); };
}

async function checkReadiness(fetcher: typeof fetch, signal: AbortSignal): Promise<boolean> {
    const response = await fetcher('/api/health', { cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) { await response.body?.cancel(); return false; }
    return (await response.json()).ready === true;
}
function claimAutomaticReload(): boolean {
    try {
        const key = 'mindos.http.last-reload', previous = Number(sessionStorage.getItem(key));
        if (previous && Date.now() - previous < 60000) return false;
        sessionStorage.setItem(key, String(Date.now())); return true;
    } catch { return false; }
}

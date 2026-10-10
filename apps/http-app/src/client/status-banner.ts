import { t } from '@itookit/common';
import { onStorageConnectionChange, setStorageAvailable } from './connection-state';

/** Recover connectivity explicitly; never replay a write whose result is unknown. */
export function installHttpStatus(): void {
    const banner = document.createElement('aside'); banner.className = 'http-status';
    banner.setAttribute('role', 'alert'); banner.hidden = true;
    const text = document.createElement('span'), action = document.createElement('button');
    action.type = 'button'; banner.append(text, action); document.body.append(banner);
    let stale = false;
    const show = (available: boolean) => {
        banner.hidden = available && !stale;
        text.textContent = t(stale ? 'httpApp.updated' : 'httpApp.disconnected');
        action.textContent = t(stale ? 'httpApp.reload' : 'httpApp.checkConnection');
    };
    onStorageConnectionChange(show);
    window.addEventListener('vite:preloadError', event => { event.preventDefault(); stale = true; show(true); });
    action.onclick = async () => {
        if (stale) { location.reload(); return; }
        action.disabled = true;
        try {
            const response = await fetch('/api/health', { cache: 'no-store' });
            if (response.ok && (await response.json()).ready === true) setStorageAvailable(true);
        } catch { setStorageAvailable(false); }
        finally { action.disabled = false; }
    };
}

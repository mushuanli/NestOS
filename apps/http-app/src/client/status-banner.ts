import { t } from '@itookit/common';

/** A lost view is recovered by reload; commands with unknown outcomes are never replayed. */
export function installHttpStatus(): () => void {
    const abort = new AbortController(), banner = document.createElement('aside'); banner.className = 'http-status';
    banner.setAttribute('role', 'alert'); banner.hidden = true;
    const text = document.createElement('span'), action = document.createElement('button');
    action.type = 'button'; action.textContent = t('httpApp.reload'); action.onclick = () => location.reload();
    banner.append(text, action); document.body.append(banner);
    window.addEventListener('mindos:http-disconnected', () => { banner.hidden = false; text.textContent = t('httpApp.disconnected'); }, { signal: abort.signal });
    window.addEventListener('vite:preloadError', event => { event.preventDefault(); banner.hidden = false; text.textContent = t('httpApp.updated'); }, { signal: abort.signal });
    return () => { abort.abort(); banner.remove(); };
}

import { t } from '@itookit/common';
import { ConnectionRecovery } from './connection-recovery';

type Status = 'disconnected' | 'reconnecting' | 'expired' | 'update' | 'view-error';
interface StatusOptions { fetcher?: typeof fetch; reload?: () => void; }

/** Present transport recovery without discarding potentially unsaved input. */
export function installHttpStatus(options: StatusOptions = {}): () => void {
    const status = new HttpStatusBanner(options);
    return () => status.dispose();
}

class HttpStatusBanner {
    private readonly abort = new AbortController();
    private readonly banner = document.createElement('aside');
    private readonly text = document.createElement('span');
    private readonly action = document.createElement('button');
    private readonly recovery: ConnectionRecovery;
    private readonly reload: () => void;
    private state?: Status;
    constructor(options: StatusOptions) {
        this.reload = options.reload ?? (() => location.reload());
        this.recovery = new ConnectionRecovery(signal => checkReadiness(options.fetcher ?? globalThis.fetch, signal), () => this.ready());
        this.banner.className = 'http-status'; this.banner.setAttribute('role', 'alert'); this.banner.hidden = true;
        this.action.type = 'button'; this.action.textContent = t('httpApp.reload');
        this.action.onclick = () => { if (this.state === 'reconnecting') window.dispatchEvent(new Event('mindos:http-retry')); else this.reload(); };
        this.banner.append(this.text, this.action); document.body.append(this.banner);
        const signal = this.abort.signal;
        window.addEventListener('mindos:http-disconnected', event => this.disconnected(event), {signal});
        window.addEventListener('mindos:http-reconnected', () => {
            if (this.state === 'reconnecting') { this.banner.hidden = true; this.state = undefined; }
        }, {signal});
        window.addEventListener('mindos:http-view-error', () => this.show('view-error', t('httpApp.viewError'), false), {signal});
        window.addEventListener('vite:preloadError', event => { event.preventDefault(); this.show('update', t('httpApp.updated')); }, {signal});
        for (const event of ['online', 'focus']) window.addEventListener(event, () => this.recovery.retry(), {signal});
    }
    private disconnected(event: Event): void {
        if (this.state === 'view-error' || this.state === 'update') return;
        const detail = (event as CustomEvent).detail?.state;
        const state = detail === 'expired' || detail === 'reconnecting' ? detail : 'disconnected';
        this.show(state, t(state === 'expired' ? 'httpApp.viewExpired' : state === 'reconnecting' ? 'httpApp.reconnecting' : 'httpApp.disconnected'), state !== 'reconnecting');
    }
    private ready(): void {
        if (this.state === 'view-error' || this.state === 'reconnecting') return;
        this.text.textContent = t(this.state === 'expired' ? 'httpApp.viewExpiredReady' : 'httpApp.recovered');
        this.banner.hidden = false;
    }
    private show(state: Status, message: string, recover = true): void {
        this.state = state; this.banner.hidden = state === 'reconnecting' || state === 'expired'; this.text.textContent = message;
        this.action.textContent = t(state === 'reconnecting' ? 'httpApp.retry' : 'httpApp.reload');
        if (recover) this.recovery.start();
    }
    dispose(): void { this.abort.abort(); this.recovery.stop(); this.banner.remove(); }
}

async function checkReadiness(fetcher: typeof fetch, signal: AbortSignal): Promise<boolean> {
    const response = await fetcher('/api/health', { cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) { await response.body?.cancel(); return false; }
    return (await response.json()).ready === true;
}

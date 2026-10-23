import { t } from '@itookit/common';
import { ConnectionRecovery } from './connection-recovery';
import type {ApplicationConnection, ConnectionState} from './application-connection';

type Status = 'disconnected' | 'reconnecting' | 'expired' | 'update' | 'view-error';
interface StatusOptions { fetcher?: typeof fetch; reload?: () => void; recover?: () => Promise<void>; connection?: Pick<ApplicationConnection, 'subscribeStatus'>; }

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
    private recovering?: Promise<void>;
    private readonly recover?: () => Promise<void>;
    private manualReload = false;
    constructor(options: StatusOptions) {
        this.recover = options.recover;
        this.reload = options.reload ?? (() => location.reload());
        this.recovery = new ConnectionRecovery(signal => checkReadiness(options.fetcher ?? globalThis.fetch, signal), () => this.ready());
        this.banner.className = 'http-status'; this.banner.setAttribute('role', 'alert'); this.banner.hidden = true;
        this.action.type = 'button'; this.action.textContent = t('httpApp.reload');
        this.action.onclick = () => {
            if (this.state === 'reconnecting') window.dispatchEvent(new Event('mindos:http-retry'));
            else if (this.state === 'expired' && this.recover && !this.manualReload) this.restore();
            else this.reload();
        };
        this.banner.append(this.text, this.action); document.body.append(this.banner);
        const signal = this.abort.signal;
        if (options.connection) signal.addEventListener('abort', options.connection.subscribeStatus(state => this.connectionChanged(state)), {once: true});
        else this.listenConnection(signal);
        window.addEventListener('vite:preloadError', event => { event.preventDefault(); this.show('update', t('httpApp.updated')); }, {signal});
        for (const event of ['online', 'focus']) window.addEventListener(event, () => this.recovery.retry(), {signal});
        document.addEventListener('visibilitychange', () => {if (!document.hidden) this.recovery.retry();}, {signal});
    }
    private listenConnection(signal: AbortSignal): void {
        window.addEventListener('mindos:http-disconnected', event => this.disconnected(event), {signal});
        window.addEventListener('mindos:http-reconnected', () => this.connectionChanged('connected'), {signal});
        window.addEventListener('mindos:http-view-error', () => this.connectionChanged('view-error'), {signal});
    }
    private connectionChanged(state: ConnectionState): void {
        if (state === 'view-error') this.show('view-error', t('httpApp.viewError'), false);
        else if (state !== 'connected') this.disconnected(new CustomEvent('mindos:http-disconnected', {detail: {state}}));
        else if (this.state === 'reconnecting') {this.banner.hidden = true; this.state = undefined;}
    }
    private disconnected(event: Event): void {
        if (this.state === 'view-error' || this.state === 'update') return;
        const detail = (event as CustomEvent).detail?.state;
        const state = detail === 'expired' || detail === 'reconnecting' ? detail : 'disconnected';
        this.show(state, t(state === 'expired' ? 'httpApp.viewExpired' : state === 'reconnecting' ? 'httpApp.reconnecting' : 'httpApp.disconnected'), state !== 'reconnecting');
    }
    private ready(): void {
        if (this.state === 'view-error' || this.state === 'reconnecting') return;
        if (this.state === 'expired' && this.recover) {this.restore(); return;}
        this.text.textContent = t(this.state === 'expired' ? 'httpApp.viewExpiredReady' : 'httpApp.recovered');
        this.banner.hidden = false;
    }
    private restore(): void {
        if (this.recovering || this.abort.signal.aborted) return;
        this.banner.hidden = true; this.action.disabled = true;
        this.recovering = Promise.resolve().then(() => this.recover!()).catch(error => {
            if (this.abort.signal.aborted) return;
            this.text.textContent = t('httpApp.autoRecoveryFailed', {reason: error instanceof Error ? error.message : t('httpApp.recoveryUnsupported')});
            this.manualReload = ['RECOVERY_SETTINGS_FORM', 'RECOVERY_UNSUPPORTED_EDITOR', 'RECOVERY_UNSUPPORTED_WORKSPACE'].includes((error as {code?: string})?.code ?? '');
            this.action.textContent = t(this.manualReload ? 'httpApp.reload' : 'httpApp.retry'); this.banner.hidden = false;
        }).finally(() => {this.recovering = undefined; this.action.disabled = false;});
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

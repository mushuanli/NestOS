import { t, escapeAttr } from '@itookit/common';
import { Toast } from '@itookit/ui-common';
import type { IConnectionService, ProviderAuthorizationState } from '@itookit/kernel-adapters/contracts';

/** The view owns no OAuth tokens, callbacks listener or background refresh loop. */
export class ProviderAuthorizationPanel {
    private unsubscribe?: () => void;
    private generation = 0;
    private last?: string;
    private status?: ProviderAuthorizationState['status'];
    private disposed = false;
    constructor(private readonly root: HTMLElement, private readonly providerId: string,
        private readonly service: IConnectionService, private readonly authorized: () => Promise<void>) {
        root.addEventListener('input', event => event.stopPropagation());
        root.addEventListener('change', event => event.stopPropagation());
    }
    async init(): Promise<void> {
        this.unsubscribe = this.service.onChange(() => { void this.refresh().catch(() => {}); });
        await this.refresh();
    }
    destroy(): void { this.disposed = true; this.generation++; this.unsubscribe?.(); }
    private async refresh(): Promise<void> {
        const generation = ++this.generation;
        const state = await this.service.getProviderAuthorization?.(this.providerId) ?? { supported: false, status: 'signed-out' };
        if (this.disposed || generation !== this.generation) return;
        const fingerprint = JSON.stringify(state); if (fingerprint === this.last) return;
        const completed = this.status === 'pending' && state.status === 'authorized' && !state.issue;
        this.last = fingerprint; this.status = state.status; this.render(state);
        if (completed) await this.authorized();
    }
    private render(state: ProviderAuthorizationState): void {
        this.root.innerHTML = `<h3>${t('provider.auth.title')}</h3><p>${t('provider.auth.description')}</p>
            <p role="status">${t(`provider.auth.${state.supported ? state.status : 'unsupported'}`)}${state.account ? ` · ${escapeAttr(state.account)}` : ''}</p>
            ${state.issue ? `<p role="alert">${t(`provider.auth.issue.${issueKey(state.issue)}`)}</p>` : ''}
            <div class="provider-authorization__actions"></div>
            ${state.pending ? `<p>${t('provider.auth.remoteHint')}</p><label>${t('provider.auth.callback')}
                <input type="url" class="settings-form__input" data-auth-callback autocomplete="off" spellcheck="false" placeholder="${escapeAttr(state.pending.callbackUri)}"></label>` : ''}`;
        const actions = this.root.querySelector<HTMLElement>('.provider-authorization__actions')!;
        if (!state.supported) return;
        if (state.pending) {
            const link = document.createElement('a'); link.href = state.pending.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.className = 'settings-btn settings-btn--primary'; link.textContent = t('provider.auth.continue'); actions.append(link);
            this.button(actions, t('provider.auth.complete'), () => this.service.completeProviderAuthorization!(this.providerId,
                state.pending!.id, this.root.querySelector<HTMLInputElement>('[data-auth-callback]')!.value));
            this.button(actions, t('action.cancel'), () => this.service.cancelProviderAuthorization!(this.providerId));
        } else {
            this.button(actions, t('provider.auth.continue'), () => this.service.beginProviderAuthorization!(this.providerId));
            if (state.status === 'authorized' || state.status === 'reauthorize') this.button(actions,
                t('provider.auth.disconnect'), () => this.service.disconnectProviderAuthorization!(this.providerId));
        }
    }
    private button(parent: HTMLElement, label: string, action: () => Promise<ProviderAuthorizationState>): void {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-btn settings-btn--secondary';
        button.textContent = label;
        button.onclick = () => {
            button.disabled = true;
            void action().then(() => this.refresh()).catch(error => Toast.error(String(error)))
                .finally(() => { button.disabled = false; });
        };
        parent.append(button);
    }
}
function issueKey(issue: string): 'authorization-failed' | 'consent-denied' | 'reauthorization-required' | 'revocation-unconfirmed' | 'refresh-unavailable' {
    return ['consent-denied', 'reauthorization-required', 'revocation-unconfirmed', 'refresh-unavailable'].includes(issue)
        ? issue as ReturnType<typeof issueKey> : 'authorization-failed';
}

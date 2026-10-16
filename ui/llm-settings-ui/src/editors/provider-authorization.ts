import { t, escapeAttr, escapeHTML, getLocale, type LocaleKey } from '@itookit/common';
import { Toast, copyText } from '@itookit/ui-common';
import type { IConnectionService, ProviderAuthorizationState } from '@itookit/kernel-adapters/contracts';

type PendingAuthorization = NonNullable<ProviderAuthorizationState['pending']>;

/** The view owns no OAuth tokens, callback listener or background refresh loop. */
export class ProviderAuthorizationPanel {
    private unsubscribe?: () => void;
    private generation = 0;
    private last?: string;
    private status?: ProviderAuthorizationState['status'];
    private disposed = false;
    private progress?: LocaleKey;
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
        if (this.disposed) return;
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
            <p role="status" data-auth-status>${t(`provider.auth.${state.supported ? state.status : 'unsupported'}`)}${state.account ? ` · ${escapeHTML(state.account)}` : ''}</p>
            <p role="status" data-auth-progress hidden></p>
            ${state.issue ? `<p role="alert">${t(`provider.auth.issue.${issueKey(state.issue)}`)}</p>` : ''}
            ${state.pending ? this.pendingMarkup(state.pending) : ''}
            <div class="provider-authorization__actions" data-auth-actions></div>`;
        if (state.supported) this.renderActions(state);
        this.setProgress(this.progress);
    }
    private pendingMarkup(pending: PendingAuthorization): string {
        const expires = new Date(pending.expiresAt).toLocaleString(getLocale());
        return `<label class="provider-authorization__field">${t('provider.auth.url')}
                <textarea class="settings-form__textarea provider-authorization__url" data-auth-url readonly rows="4" spellcheck="false">${escapeHTML(pending.url)}</textarea></label>
            <p class="settings-form__help">${t('provider.auth.urlHint')}</p>
            <p class="settings-form__help">${t('provider.auth.expires', { time: expires })}</p>
            <div class="provider-authorization__actions" data-auth-links></div>
            <p class="settings-form__help">${t('provider.auth.regenerateHint')}</p>
            <p>${t('provider.auth.remoteHint')}</p>
            <label class="provider-authorization__field">${t('provider.auth.callback')}
                <input type="url" class="settings-form__input" data-auth-callback autocomplete="off" spellcheck="false" placeholder="${escapeAttr(pending.callbackUri)}"></label>`;
    }
    private renderActions(state: ProviderAuthorizationState): void {
        const actions = this.root.querySelector<HTMLElement>('[data-auth-actions]')!;
        if (state.pending) {
            const navigation = this.root.querySelector<HTMLElement>('[data-auth-links]')!;
            const link = document.createElement('a'); link.href = state.pending.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.className = 'settings-btn settings-btn--primary'; link.textContent = t('provider.auth.open'); navigation.append(link);
            this.copyButton(navigation, state.pending.url);
            this.button(navigation, t('provider.auth.regenerate'), () => this.regenerate(), 'provider.auth.preparing');
            this.button(actions, t('provider.auth.complete'), async () => {
                const input = this.root.querySelector<HTMLInputElement>('[data-auth-callback]')!;
                if (!input.value.trim()) { input.focus(); throw new Error(t('provider.auth.callbackRequired')); }
                return this.service.completeProviderAuthorization!(this.providerId, state.pending!.id, input.value.trim());
            }, 'provider.auth.verifying');
            this.button(actions, t('action.cancel'), () => this.service.cancelProviderAuthorization!(this.providerId));
        } else {
            this.button(actions, t('provider.auth.continue'), () => this.service.beginProviderAuthorization!(this.providerId), 'provider.auth.preparing');
            if (state.status === 'authorized' || state.status === 'reauthorize') this.button(actions,
                t('provider.auth.disconnect'), () => this.service.disconnectProviderAuthorization!(this.providerId));
        }
    }
    private async regenerate(): Promise<ProviderAuthorizationState> {
        await this.service.cancelProviderAuthorization!(this.providerId);
        try { return await this.service.beginProviderAuthorization!(this.providerId); }
        catch (error) { await this.refresh(); throw error; }
    }
    private copyButton(parent: HTMLElement, url: string): void {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-btn settings-btn--secondary';
        button.textContent = t('provider.auth.copy');
        button.onclick = () => {
            if (this.disposed || this.progress) return;
            void copyText(url).then(copied => {
                if (this.disposed) return;
                if (copied) Toast.success(t('editor.copySuccess'));
                else {
                    const input = this.root.querySelector<HTMLTextAreaElement>('[data-auth-url]'); input?.focus(); input?.select();
                    Toast.error(t('provider.auth.copyFailed'));
                }
            });
        };
        parent.append(button);
    }
    private button(parent: HTMLElement, label: string, action: () => Promise<ProviderAuthorizationState>,
        progress: LocaleKey = 'provider.auth.working'): void {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-btn settings-btn--secondary';
        button.textContent = label;
        button.onclick = () => {
            if (this.disposed || this.progress) return;
            this.setProgress(progress);
            void action().then(() => this.refresh()).catch(error => { if (!this.disposed) Toast.error(String(error)); })
                .finally(() => { if (!this.disposed) this.setProgress(); });
        };
        parent.append(button);
    }
    private setProgress(progress?: LocaleKey): void {
        this.progress = progress; this.root.setAttribute('aria-busy', String(Boolean(progress)));
        this.root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = Boolean(progress); });
        const status = this.root.querySelector<HTMLElement>('[data-auth-status]'); if (status) status.hidden = Boolean(progress);
        const notice = this.root.querySelector<HTMLElement>('[data-auth-progress]');
        if (notice) { notice.hidden = !progress; notice.textContent = progress ? t(progress) : ''; }
    }
}
function issueKey(issue: string): 'authorization-failed' | 'consent-denied' | 'reauthorization-required' | 'revocation-unconfirmed' | 'refresh-unavailable' {
    return ['consent-denied', 'reauthorization-required', 'revocation-unconfirmed', 'refresh-unavailable'].includes(issue)
        ? issue as ReturnType<typeof issueKey> : 'authorization-failed';
}

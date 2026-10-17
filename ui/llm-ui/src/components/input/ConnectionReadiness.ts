import { t } from '@itookit/common';
import type { ConnectionIssue } from './ConnectionTierController';

export type ConnectionLoadState = 'loading' | 'ready' | 'failed';
interface Actions {
    navigate?(target: {resourceId: string; anchor?: string}): void;
    choose(): void;
    retry(): void;
}

let noticeSequence = 0;

/** Safe configuration metadata only; providers own authentication and credential validation. */
export class ConnectionReadiness {
    private readonly notice: HTMLElement;
    private readonly message: HTMLElement;
    private readonly configure: HTMLButtonElement;
    private readonly choose: HTMLButtonElement;
    private readonly retry: HTMLButtonElement;
    private target?: ConnectionIssue['target'];
    blocked = false;

    constructor(container: HTMLElement, actions: Actions) {
        this.notice = container.querySelector('.llm-input__connection-notice')!;
        this.notice.id = `llm-connection-notice-${++noticeSequence}`;
        this.message = this.notice.querySelector('[data-connection-message]')!;
        this.configure = this.notice.querySelector('[data-connection-configure]')!;
        this.choose = this.notice.querySelector('[data-connection-choose]')!;
        this.retry = this.notice.querySelector('[data-connection-retry]')!;
        this.configure.hidden = !actions.navigate;
        this.configure.onclick = () => { if (this.target) actions.navigate?.(this.target); };
        this.choose.onclick = actions.choose; this.retry.onclick = actions.retry;
    }

    update(required: boolean, state: ConnectionLoadState, issue: ConnectionIssue | undefined, send: HTMLButtonElement): void {
        const kind = state === 'ready' ? issue?.kind : state;
        this.blocked = required && !!kind;
        this.notice.hidden = !this.blocked;
        this.target = issue?.target ?? {resourceId: 'connections'};
        if (!this.blocked) { send.removeAttribute('aria-describedby'); return; }
        this.message.textContent = t(`chatInput.connectionStatus.${kind!}`, {name: issue?.name ?? ''});
        this.configure.textContent = t(kind === 'credentials' ? 'chatInput.connectionStatus.authorize' : 'chatInput.connectionStatus.configure');
        this.choose.hidden = state !== 'ready'; this.retry.hidden = state !== 'failed';
        send.setAttribute('aria-describedby', this.notice.id);
    }

    destroy(): void { this.configure.onclick = this.choose.onclick = this.retry.onclick = null; }
}

import {t} from '@itookit/common';

export interface ConnectionNotice {type: string; formId: string; state: 'saving' | 'verifying' | 'saved' | 'error'; message: string}

export function connectionFeedback(body: HTMLElement, notices: Map<string, ConnectionNotice>, busy: boolean, canVerify: boolean): void {
    for (const submit of body.querySelectorAll<HTMLButtonElement>('[data-form=sourceConnection] button[type=submit], [data-connection-verify]')) submit.disabled = busy;
    for (const button of body.querySelectorAll<HTMLButtonElement>('[data-connection-verify]')) button.disabled = busy || !canVerify;
    for (const upload of body.querySelectorAll<HTMLInputElement>('[name=connectionImport]')) upload.disabled = busy;
    for (const [id, notice] of notices) {
        const forms = [...body.querySelectorAll<HTMLFormElement>('[data-form=sourceConnection]')];
        const form = forms.find(form => form.dataset.id === id) ?? forms.find(form => form.dataset.id === notice.formId && form.dataset.type === notice.type);
        if (!form) continue;
        const message = document.createElement('p'); message.dataset.connectionFeedback = id;
        message.setAttribute('role', notice.state === 'error' ? 'alert' : 'status'); message.setAttribute('aria-live', 'polite'); message.textContent = notice.message;
        form.prepend(message);
        if (notice.state === 'saving' || notice.state === 'verifying') {
            const submit = form.querySelector<HTMLButtonElement>('button[type=submit]');
            if (submit) {submit.textContent = t(notice.state === 'saving' ? 'toolbox.connections.savingConnection' : 'toolbox.connections.verifyingConnection'); submit.setAttribute('aria-busy', 'true');}
        }
    }
}

export function revealConnection(body: HTMLElement, id: string): boolean {
    const account = [...body.querySelectorAll<HTMLDetailsElement>('[data-connection-details]')].find(item => item.dataset.connectionDetails === 'account:' + id);
    if (!account) return false;
    for (const setup of account.closest('[data-connection-type]')!.querySelectorAll<HTMLDetailsElement>('[data-method-panel]')) setup.open = false;
    let parent: HTMLElement | null = account;
    while (parent && parent !== body) {if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement;}
    account.scrollIntoView?.({block: 'nearest'}); return true;
}

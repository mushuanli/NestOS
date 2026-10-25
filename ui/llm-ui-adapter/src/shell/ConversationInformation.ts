import {ACTION_ICONS, escapeHTML, t} from '@itookit/common';
import type {ConversationSnapshot} from '@itookit/ui-common';
import {setTimePresentation} from '@itookit/ui-common';
import {conversationUsage} from './conversation-usage';

/** Secondary diagnostics stay behind More; updates never replace input or history DOM. */
export class ConversationInformation {
    private readonly button = document.createElement('button');
    private dialog?: HTMLDialogElement;
    private snapshot?: ConversationSnapshot;
    private status = '';
    private tooltip = '';
    constructor(parent: HTMLElement) {
        this.button.type = 'button'; this.button.className = 'llm-workspace-titlebar__btn';
        this.button.innerHTML = ACTION_ICONS.info; this.button.title = t('project.sessionInfo');
        this.button.setAttribute('aria-label', this.button.title); this.button.setAttribute('aria-haspopup', 'dialog');
        this.button.dataset.action = 'conversation-information'; this.button.onclick = () => this.open(); parent.append(this.button);
    }
    setSnapshot(snapshot: ConversationSnapshot): void {this.snapshot = snapshot; this.refresh();}
    setStatus(text: string, tooltip = ''): void {this.status = text; this.tooltip = tooltip; this.refresh();}
    private open(): void {
        if (this.dialog?.open) return;
        const dialog = this.dialog = document.createElement('dialog'); dialog.className = 'remote-conversation-info';
        dialog.setAttribute('aria-label', t('project.sessionInfo'));
        dialog.innerHTML = `<header class="remote-conversation-info__header"><strong>${escapeHTML(t('project.sessionInfo'))}</strong>
            <button type="button" aria-label="${escapeHTML(t('action.close'))}" title="${escapeHTML(t('action.close'))}">${ACTION_ICONS.close}</button></header>
            <div class="remote-conversation-info__body"><dl class="remote-conversation-info__times">
            <dt>${escapeHTML(t('project.createdAt'))}</dt><dd><time data-session-time="createdAt"></time></dd>
            <dt>${escapeHTML(t('project.lastActivity'))}</dt><dd><time data-session-time="updatedAt"></time></dd></dl>
            <p class="remote-conversation-info__help">${escapeHTML(t('harness.activityHint'))}</p>
            <section><h3>${escapeHTML(t('harness.runtimeStatus'))}</h3>
            <p data-session-info-status></p><p class="remote-conversation-info__help" data-session-info-observation></p></section>
            <section data-session-info-meter><h3>${escapeHTML(t('harness.usageTitle'))}</h3><p data-session-info-usage></p>
            <p class="remote-conversation-info__help">${escapeHTML(t('harness.usageHelp'))}</p></section></div>`;
        dialog.querySelector('button')!.onclick = () => dialog.close();
        dialog.addEventListener('click', event => {if (event.target === dialog) dialog.close();});
        dialog.addEventListener('close', () => {
            dialog.remove(); if (this.dialog === dialog) this.dialog = undefined;
            if (this.button.isConnected) (this.button.closest('details')?.querySelector('summary') ?? this.button).focus();
        }, {once: true});
        document.body.append(dialog); this.refresh(); dialog.showModal();
    }
    private refresh(): void {
        const dialog = this.dialog; if (!dialog) return;
        for (const element of dialog.querySelectorAll<HTMLTimeElement>('time[data-session-time]')) {
            const field = element.dataset.sessionTime as 'createdAt' | 'updatedAt';
            setTimePresentation(element, this.snapshot?.[field], t('project.timeUnknown'));
        }
        dialog.querySelector('[data-session-info-status]')!.textContent = this.status;
        dialog.querySelector('[data-session-info-observation]')!.textContent = [
            this.snapshot?.observation?.scope ? t(`harness.scope.${this.snapshot.observation.scope}`) : '',
            this.snapshot?.observation?.rawStatus === 'notLoaded' ? t('harness.unloadedHelp') : '', this.tooltip,
        ].filter(Boolean).join('\n');
        const usage = this.snapshot ? conversationUsage(this.snapshot) : '';
        dialog.querySelector('[data-session-info-usage]')!.textContent = usage;
        dialog.querySelector<HTMLElement>('[data-session-info-meter]')!.hidden = !usage;
    }
    destroy(): void {this.dialog?.close(); this.dialog?.remove(); this.dialog = undefined; this.button.remove();}
}

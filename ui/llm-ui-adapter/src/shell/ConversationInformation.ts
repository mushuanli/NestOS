import type {ConversationSnapshot} from '../contracts';
import {ACTION_ICONS, escapeHTML, t} from '@itookit/common';

import {setTimePresentation} from '@itookit/ui-common-adapter';
import {conversationMetrics} from './conversation-metrics';
import {conversationUsage} from './conversation-usage';
import {nativeWriterLockText} from './native-writer-lock';

/** Secondary diagnostics stay behind More; updates never replace input or history DOM. */
export class ConversationInformation {
    private readonly button = document.createElement('button');
    private dialog?: HTMLDialogElement;
    private snapshot?: ConversationSnapshot;
    private status = '';
    private tooltip = '';
    constructor(parent: HTMLElement, private readonly readMetrics?: () => Promise<ConversationSnapshot>) {
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
            <p data-session-info-status></p><p class="remote-conversation-info__help" data-session-info-observation></p>
            <p class="remote-conversation-info__help" data-native-writer-lock></p></section>
            <section data-session-info-meter><h3>${escapeHTML(t('harness.usageTitle'))}</h3><p data-session-info-usage></p>
            <p class="remote-conversation-info__help">${escapeHTML(t('harness.usageHelp'))}</p></section>
            <section><h3>${escapeHTML(t('harness.metricsTitle'))}</h3>
            <button type="button" data-action="refresh-native-metrics" aria-label="${escapeHTML(t('harness.metricsRefresh'))}" title="${escapeHTML(t('harness.metricsRefresh'))}">${ACTION_ICONS.refreshView}</button>
            <dl class="remote-conversation-info__times" data-session-info-metrics></dl>
            <p class="remote-conversation-info__help">${escapeHTML(t('harness.metricsHelp'))}</p></section></div>`;
        dialog.querySelector<HTMLButtonElement>('[data-action=refresh-native-metrics]')!.onclick = () => {void this.loadMetrics(dialog);};
        dialog.querySelector('button')!.onclick = () => dialog.close();
        dialog.addEventListener('click', event => {if (event.target === dialog) dialog.close();});
        dialog.addEventListener('close', () => {
            dialog.remove(); if (this.dialog === dialog) this.dialog = undefined;
            if (this.button.isConnected) (this.button.closest('details')?.querySelector('summary') ?? this.button).focus();
        }, {once: true});
        document.body.append(dialog); this.refresh(); dialog.showModal(); void this.loadMetrics(dialog);
    }
    private async loadMetrics(dialog: HTMLDialogElement): Promise<void> {
        const button = dialog.querySelector<HTMLButtonElement>('[data-action=refresh-native-metrics]')!;
        if (!this.readMetrics || !this.snapshot?.supportsMetrics || button.disabled) return;
        button.disabled = true;
        try {const state = await this.readMetrics(); if (this.dialog === dialog) this.setSnapshot(state);}
        catch (error) {
            if (this.dialog !== dialog || !this.snapshot) return;
            const code = (error as {code?: string})?.code;
            this.setSnapshot({...this.snapshot, metricsError: {code: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'HARNESS_METRICS_UNAVAILABLE'}});
        } finally {if (this.dialog === dialog) button.disabled = !this.readMetrics || !this.snapshot?.supportsMetrics;}
    }
    private refresh(): void {
        const dialog = this.dialog; if (!dialog) return;
        for (const element of dialog.querySelectorAll<HTMLTimeElement>('time[data-session-time]')) {
            const field = element.dataset.sessionTime as 'createdAt' | 'updatedAt';
            setTimePresentation(element, this.snapshot?.[field], t('project.timeUnknown'));
        }
        dialog.querySelector('[data-session-info-status]')!.textContent = this.status;
        dialog.querySelector('[data-native-writer-lock]')!.textContent = nativeWriterLockText(this.snapshot?.writerLock);
        dialog.querySelector('[data-session-info-observation]')!.textContent = [
            this.snapshot?.observation?.scope ? t(`harness.scope.${this.snapshot.observation.scope}`) : '',
            this.snapshot?.observation?.rawStatus === 'notLoaded' ? t('harness.unloadedHelp') : '', this.tooltip,
        ].filter(Boolean).join('\n');
        const metrics = dialog.querySelector('[data-session-info-metrics]')!;
        metrics.replaceChildren(...(this.snapshot ? conversationMetrics(this.snapshot) : []).flatMap(([label, value]) => {
            const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; return [dt, dd];
        }));
        dialog.querySelector<HTMLButtonElement>('[data-action=refresh-native-metrics]')!.hidden = !this.readMetrics || !this.snapshot?.supportsMetrics;
        const usage = this.snapshot ? conversationUsage(this.snapshot) : '';
        dialog.querySelector('[data-session-info-usage]')!.textContent = usage;
        dialog.querySelector<HTMLElement>('[data-session-info-meter]')!.hidden = !usage;
    }
    destroy(): void {this.dialog?.close(); this.dialog?.remove(); this.dialog = undefined; this.button.remove();}
}

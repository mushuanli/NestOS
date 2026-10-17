import { ENTITY_ICONS, escapeHTML, getLocale, t } from '@itookit/common';
import { copyText, Modal, type EditorOptions } from '@itookit/ui-common';
import { LLMPrintService } from '@itookit/mdx-adapter';
import { MDxRenderer } from '@itookit/mdxeditor';
import { ChatInput } from '../components/input/ChatInputView';
import { LayoutTemplates } from '../components/templates/LayoutTemplates';
import { updateCollapseAction } from '../components/history/HistoryToolbar';
import { EventBinder } from './EventBinder';
import { DOMCache } from '../components/common';
import { StatusIndicatorView } from '../components/indicators/StatusIndicatorView';
import { RemoteHistory } from './remote-history';
import { conversationUsage } from './conversation-usage';
import type { ConversationSnapshot } from '@itookit/ui-common';

interface Actions {
    attachments?: Array<'text' | 'image'>;
    rename?(title: string): void;
    send(text: string, files?: File[]): Promise<void>;
    stop(): void;
    refresh(): void;
    reconcile(): void;
    earlier(): void;
    openPrompts?(): void;
    changed(files?: File[]): void;
    copy(): string;
}

/** Shared workspace layout and input; the controller supplies native capabilities. */
export class ConversationWorkspaceView {
    readonly history: RemoteHistory;
    readonly input: ChatInput;
    readonly interactions = document.createElement('div');
    readonly status = document.createElement('p');
    private readonly usage = document.createElement('p');
    readonly reconcile: HTMLButtonElement;
    readonly earlier: HTMLButtonElement;
    private readonly progress = document.createElement('div');
    private readonly progressText = document.createElement('span');
    private readonly events: EventBinder;
    private readonly indicator: StatusIndicatorView;
    private readonly renameButton: HTMLButtonElement;
    private renameDialog?: Modal;
    constructor(private readonly container: HTMLElement, options: EditorOptions, actions: Actions) {
        container.classList.add('llm-ui-workspace');
        container.innerHTML = LayoutTemplates.renderWorkspace(options.title ?? t('harness.remoteSessions'));
        const history = container.querySelector<HTMLElement>('#llm-ui-history')!;
        this.indicator = new StatusIndicatorView(new DOMCache(container), () => false, () => {});
        this.configureTitle(); this.events = this.configureToolbar(options, actions);
        const toolbar = container.querySelector<HTMLElement>('.llm-workspace-titlebar__menu-actions')!;
        this.renameButton = this.button(t('project.renameSession'), () => this.rename(actions), toolbar); this.renameButton.hidden = true;
        this.progress.className = 'remote-conversation__history-progress'; this.progress.hidden = true;
        this.progress.append(this.progressText);
        this.earlier = this.button(t('harness.earlierHistory'), actions.earlier, this.progress); this.earlier.hidden = true;
        this.earlier.className = 'remote-conversation__earlier';
        this.progress.setAttribute('aria-live', 'polite');
        this.history = new RemoteHistory(history, container, this.progress, {
            refresh: actions.openPrompts, earlier: actions.earlier,
        });
        this.reconcile = this.button(t('harness.reconcile'), actions.reconcile, toolbar); this.reconcile.disabled = true;
        this.input = this.createInput(options, actions);
        this.input.setAvailability({canSend: false, canInterrupt: false});
        this.interactions.className = 'remote-conversation__interactions';
        this.status.className = 'remote-conversation__status'; this.status.setAttribute('role', 'status');
        this.usage.className = 'remote-conversation__status'; this.usage.hidden = true;
        this.usage.title = t('harness.usageHelp'); this.usage.setAttribute('aria-live', 'polite');
        const input = container.querySelector('#llm-ui-input')!; input.before(this.interactions, this.status, this.usage);
    }
    private configureTitle(): void {
        const title = this.container.querySelector<HTMLInputElement>('#llm-title-input')!;
        title.readOnly = true;
        const marker = document.createElement('span'); marker.textContent = ENTITY_ICONS.remoteSession;
        marker.title = t('harness.remoteSessions'); title.before(marker);
    }
    private configureToolbar(options: EditorOptions, actions: Actions): EventBinder {
        for (const id of ['llm-btn-assets', 'llm-btn-flow-output', 'llm-btn-session-rerun']) {
            this.container.querySelector<HTMLButtonElement>('#' + id)!.hidden = true;
        }
        this.container.querySelector<HTMLButtonElement>('#llm-btn-sidebar')!.hidden = !options.hostContext?.toggleSidebar;
        const events = new EventBinder(this.container, {
            mountCompactNavigation: options.mountCompactNavigation,
            mountMoreMenu: options.mountMoreMenu,
            onToggleSidebar: () => options.hostContext?.toggleSidebar(),
            onRefresh: actions.refresh,
            onCollapseAll: () => { updateCollapseAction(this.container.querySelectorAll<HTMLElement>('#llm-btn-collapse')[0], this.history.view.toggleAllFold()); },
            onFoldCurrent: () => this.history.view.foldCurrentUnfolded(),
            onCopy: () => { void copyText(actions.copy()).catch(error => { this.status.textContent = String(error); }); },
            onToggleNavigator: () => this.history.navigation.toggle(),
            onPrevUnfolded: () => this.history.navigation.navigate('prev'),
            onNextUnfolded: () => this.history.navigation.navigate('next'),
            onPrint: () => { void this.print().catch(error => this.setStatus(String(error))); },
            onTitleChange: title => actions.rename?.(title),
        });
        events.bindTitleBarEvents(); events.bindNavigationEvents();
        return events;
    }
    private async print(): Promise<void> {
        const service = new LLMPrintService(), renderer = new MDxRenderer({ htmlPolicy: 'literal' }).usePlugin(this.history.markdownPlugin);
        const content = document.createElement('div');
        try {
            await renderer.render(content, this.history.markdown());
            await service.printFromHtml(content.innerHTML, {title: this.container.querySelector<HTMLInputElement>('#llm-title-input')!.value, showHeader: true});
        } finally { renderer.destroy(); service.destroy?.(); }
    }
    private createInput(options: EditorOptions, actions: Actions): ChatInput {
        const executorId = options.initialInputState?.agentId?.startsWith('remote:') ? options.initialInputState.agentId : 'remote:native';
        return new ChatInput(this.container.querySelector<HTMLElement>('#llm-ui-input')!, {
            executorUsage: options.executorUsage,
            attachments: !!actions.attachments?.length, executorLocked: true,
            onSwitchExecutionTarget: options.onStartConversationDraft,
            attachmentAccept: [...(actions.attachments?.includes('text') ? ['text/*', 'application/json', 'application/xml'] : []),
                ...(actions.attachments?.includes('image') ? ['image/png', 'image/jpeg', 'image/webp'] : [])].join(','),
            attachmentHint: t('harness.attachmentType') + ' ' + t('harness.attachmentCapacity'),
            initialAgents: [{id: executorId, name: options.title ?? t('harness.remoteSessions'), icon: ENTITY_ICONS.remoteAgent, category: t('harness.remoteAgents')}],
            initialConfig: {text: options.initialInputState?.text ?? '', agentId: executorId},
            onSend: (text, files) => actions.send(text, files),
            onStop: actions.stop, onDraftChange: (_config, files) => actions.changed(files),
        });
    }
    private button(label: string, action: () => void, parent: HTMLElement): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'llm-workspace-titlebar__btn llm-workspace-titlebar__btn--text';
        button.textContent = label; button.onclick = action; parent.append(button); return button;
    }
    setTitle(title: string): void {
        const input = this.container.querySelector<HTMLInputElement>('#llm-title-input')!;
        if (document.activeElement !== input || input.readOnly) input.value = title;
    }
    setUsage(snapshot: ConversationSnapshot): void {
        this.usage.textContent = conversationUsage(snapshot);
        this.usage.hidden = !this.usage.textContent;
    }
    setRenameAvailability(enabled: boolean): void {
        this.container.querySelector<HTMLInputElement>('#llm-title-input')!.readOnly = !enabled;
        this.renameButton.hidden = !enabled;
    }
    private rename(actions: Actions): void {
        const title = this.container.querySelector<HTMLInputElement>('#llm-title-input')!.value;
        this.renameDialog?.hide();
        this.renameDialog = new Modal(t('project.renameSession'), `<label class="settings-form__label">${escapeHTML(t('project.sessionName'))}
            <input class="settings-form__input" value="${escapeHTML(title)}" /></label>`, {
            confirmText: t('project.save'), cancelText: t('project.cancel'),
            onConfirm: element => {
                const name = element.querySelector<HTMLInputElement>('input')!.value.trim();
                if (!name) return false;
                actions.rename?.(name);
            },
        });
        this.renameDialog.show();
    }
    setSessionTimes(createdAt?: number | null, updatedAt?: number | null): void {
        this.container.querySelector<HTMLInputElement>('#llm-title-input')!.title = [[t('workbench.created'), createdAt], [t('workbench.modified'), updatedAt]]
            .filter(([, time]) => typeof time === 'number' && time > 0)
            .map(([label, time]) => `${label}: ${new Date(time!).toLocaleString(getLocale())}`).join('\n');
    }
    setHistoryProgress(count: number, hasEarlier: boolean, loading = false, error = ''): void {
        this.history.navigation.prompts.setEarlier(hasEarlier, loading || this.earlier.disabled, error);
        this.progress.hidden = !hasEarlier;
        this.progress.setAttribute('aria-busy', String(loading));
        this.progressText.textContent = t(loading ? 'harness.loadingEarlier' : 'harness.partialHistory', {count}) + (error ? ` ${error}` : '');
    }
    setStatus(text: string, state = 'failed'): void {
        this.status.textContent = text;
        this.indicator.update(state, text || t('harness.ready'));
    }
    destroy(): Promise<void> { this.renameDialog?.hide(); this.events.cleanup(); this.indicator.destroy(); this.input.destroy(); this.container.classList.remove('llm-ui-workspace'); return this.history.destroy(); }
}

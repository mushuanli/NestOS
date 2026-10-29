import type {MessageAction} from '@itookit/llm-ui';
import {ACTION_ICONS, escapeHTML, t} from '@itookit/common';
import {Modal, type ConversationControls, type ConversationSnapshot, type EditorOptions} from '@itookit/ui-common';
import {remoteBranchTargets} from './remote-rounds';

/** Mutating native history stays outside the read-only transcript renderer. */
export class RemoteHistoryBranches {
    private snapshot?: ConversationSnapshot;
    private working = false;
    private choosing = false;
    private closed = false;
    private active = true;
    private revision = 0;
    private dismiss?: () => void;
    private readonly click = (event: Event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-native-branch]');
        if (button && this.container.contains(button)) void this.create(button.dataset.nativeBranch!).catch(this.error);
    };
    constructor(private readonly container: HTMLElement, private readonly controls: ConversationControls,
        private readonly options: EditorOptions, private readonly run: (action: () => Promise<ConversationSnapshot>) => Promise<void>,
        private readonly error: (error: unknown) => void) {container.addEventListener('click', this.click);}
    update(snapshot: ConversationSnapshot, working: boolean): void {
        this.snapshot = snapshot; this.working = working;
        for (const target of remoteBranchTargets(snapshot.messages)) {
            const actions = this.container.querySelector<HTMLElement>(`[data-session-id="${target.id}"] .llm-ui-actions`);
            if (!actions) continue;
            let button = actions.querySelector<HTMLButtonElement>('[data-native-branch]');
            if (this.options.readOnly) {button?.remove(); continue;}
            if (!button) {
                button = document.createElement('button'); button.type = 'button'; button.className = 'llm-icon-btn';
                button.dataset.nativeBranch = target.id; button.innerHTML = ACTION_ICONS.branch; actions.append(button);
            }
            button.title = t(this.support() === 'none' ? 'branch.unsupported' : 'branch.continue'); button.setAttribute('aria-label', button.title);
            button.setAttribute('aria-disabled', String(working || !snapshot.canFork || this.support() === 'none'));
        }
    }
    actions(messageId: string): MessageAction[] {
        const target = remoteBranchTargets(this.snapshot?.messages ?? []).find(item => item.messageId === messageId);
        if (!target || this.options.readOnly) return [];
        return [{id: 'branch', label: t(this.support() === 'none' ? 'branch.unsupported' : 'branch.continue'),
            disabled: this.working || !this.snapshot?.canFork || this.support() === 'none', run: () => this.create(target.id)}];
    }
    private support(): 'none' | 'latest' | 'turn' {
        return this.snapshot?.forkSupport ?? (this.controls.forkAt ? 'turn' : this.controls.fork ? 'latest' : 'none');
    }
    private async create(id: string): Promise<void> {
        if (this.closed || !this.active || this.choosing || this.options.readOnly) return;
        if (this.support() === 'none') throw new Error(t('branch.unsupported'));
        if (this.working || !this.snapshot?.canFork || !this.options.onConversationSession) throw new Error(t('branch.unavailable'));
        const sessionId = this.snapshot?.sessionId, revision = this.revision;
        const target = remoteBranchTargets(this.snapshot?.messages ?? []).find(row => row.id === id);
        if (!target) return;
        this.choosing = true;
        try {
            if (!target.latest && this.support() === 'latest' && !await this.confirmLatest()) return;
            if (this.closed || !this.active || revision !== this.revision || sessionId !== this.snapshot?.sessionId) return;
            if (this.working || !this.snapshot?.canFork) throw new Error(t('branch.unavailable'));
            await this.run(() => this.fork(id, sessionId, target.latest));
        } finally {this.choosing = false;}
    }
    private fork(id: string, sessionId: string | undefined, wasLatest: boolean): Promise<ConversationSnapshot> {
        const target = remoteBranchTargets(this.snapshot?.messages ?? []).find(row => row.id === id);
        if (this.closed || !this.active || this.options.readOnly || sessionId !== this.snapshot?.sessionId || !target || !this.snapshot?.canFork)
            throw new Error(t('branch.unavailable'));
        if (this.support() === 'turn' && target.turnId && this.controls.forkAt)
            return this.controls.forkAt({messageId: target.messageId, turnId: target.turnId});
        if (this.support() !== 'latest' || !this.controls.fork) throw new Error(t('branch.unsupported'));
        if (wasLatest && !target.latest) throw new Error(t('branch.unavailable'));
        return this.controls.fork();
    }
    private confirmLatest(): Promise<boolean> {
        return new Promise(resolve => {
            let finished = false;
            const finish = (accepted: boolean) => {if (!finished) {finished = true; this.dismiss = undefined; resolve(accepted);}};
            const modal = new Modal(t('branch.create'), `<p>${escapeHTML(t('branch.latestOnly'))}</p>`, {
                confirmText: t('branch.create'), cancelText: t('action.cancel'), onConfirm: () => finish(true), onCancel: () => finish(false)});
            this.dismiss = () => {finish(false); modal.hide();}; modal.show();
        });
    }
    setActive(active: boolean): void {this.active = active; if (!active) {++this.revision; this.dismiss?.();}}
    destroy(): void {this.closed = true; this.setActive(false); this.container.removeEventListener('click', this.click);}
}

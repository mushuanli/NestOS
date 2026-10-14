import { t } from '@itookit/common';
import type { ConversationControls, ConversationSnapshot, EditorOptions } from '@itookit/ui-common';
import { BranchIndicatorTemplates } from '../components/templates/BranchIndicatorTemplates';
import { EventCleanup } from '../components/common';
import type { BranchItem } from '../domain/types';

/** Native identities use the shared branch presentation, without local VCS commands. */
export class RemoteBranches {
    readonly element = document.createElement('div');
    private readonly name = document.createElement('input');
    private readonly create = document.createElement('button');
    private readonly form = document.createElement('div');
    private readonly events = new EventCleanup();
    private closed = false;
    private sessionId = '';
    private title = '';
    private unavailable = false;
    private loading = false;
    private branches: BranchItem[] = [];
    private renderKey = '';
    constructor(private readonly controls: ConversationControls, private readonly options: EditorOptions,
        run: (action: () => Promise<ConversationSnapshot>) => Promise<void>, error: (error: unknown) => void) {
        this.element.className = 'remote-conversation__branches'; this.element.hidden = true;
        this.create.disabled = this.name.disabled = true;
        this.name.placeholder = t('harness.branchName'); this.name.maxLength = 256; this.name.setAttribute('aria-label', t('harness.branchName'));
        this.create.type = 'button'; this.create.textContent = t('harness.createBranch');
        this.create.onclick = () => {
            if (!this.create.disabled) void run(() => controls.fork!(this.name.value.trim() || t('harness.defaultBranch', {time: new Date().toLocaleString()}))).catch(error);
        };
        this.form.className = 'remote-conversation__branch-create'; this.form.append(this.name, this.create);
        this.events.add(this.element, 'click', event => { void this.click(event).catch(error); });
        this.events.add(document, 'click', event => { if (!this.element.contains(event.target as Node)) this.closeDropdown(); });
        this.events.add(this.element, 'keydown', event => { if ((event as KeyboardEvent).key === 'Escape') { this.closeDropdown(); this.element.querySelector<HTMLButtonElement>('.llm-branch-indicator-btn')?.focus(); } });
    }
    update(snapshot: ConversationSnapshot, working: boolean): void {
        const changed = this.sessionId !== (snapshot.sessionId ?? '');
        this.sessionId = snapshot.sessionId ?? ''; this.title = snapshot.branchName ?? t('harness.unnamedBranch');
        this.unavailable = working || snapshot.pending || !this.options.onConversationSession;
        this.create.disabled = working || !!this.options.readOnly || !snapshot.canFork || !this.options.onConversationSession;
        this.name.disabled = this.create.disabled;
        this.element.hidden = !this.sessionId || !this.controls.fork && !this.controls.branches;
        if (changed) this.branches = [{name: this.title, headNodeId: this.sessionId, isCurrent: true}];
        else if (snapshot.branchName) this.branches = this.branches.map(branch => branch.headNodeId === this.sessionId ? {...branch, name: snapshot.branchName!} : branch);
        this.render();
    }
    private render(): void {
        const key = JSON.stringify([this.sessionId, this.title, this.unavailable, this.loading, this.branches]);
        if (key === this.renderKey || this.closed) return;
        this.renderKey = key;
        const open = this.dropdown()?.style.display === 'block';
        const current = this.branches.find(branch => branch.headNodeId === this.sessionId);
        this.element.innerHTML = BranchIndicatorTemplates.renderIndicator(current?.name || this.title, this.branches.length, true);
        const button = this.element.querySelector<HTMLButtonElement>('.llm-branch-indicator-btn')!;
        button.disabled = this.unavailable || this.loading; button.setAttribute('aria-haspopup', 'menu');
        this.setOpen(open);
    }
    private async click(event: Event): Promise<void> {
        const target = event.target as Element;
        if (target.closest('.llm-branch-indicator-btn')) {
            event.stopPropagation();
            if (this.unavailable || this.loading) return;
            if (this.dropdown()?.style.display === 'block') { this.closeDropdown(); return; }
            await this.load();
            if (!this.closed && !this.unavailable) this.setOpen(true);
        } else {
            const id = target.closest<HTMLElement>('[data-branch-name]')?.dataset.branchName;
            if (!id || this.unavailable || id === this.sessionId) return;
            this.closeDropdown(); this.options.onConversationSession?.(id);
        }
    }
    private async load(): Promise<void> {
        if (!this.controls.branches || this.loading) return;
        const id = this.sessionId; this.loading = true; this.render();
        try {
            const branches = await this.controls.branches();
            if (this.closed || id !== this.sessionId) return;
            this.branches = branches.map(branch => ({name: branch.branchName || (branch.parentSessionId ? t('harness.unnamedBranch') : 'main'), headNodeId: branch.id, isCurrent: branch.id === id}));
            if (!this.branches.some(branch => branch.isCurrent)) this.branches.unshift({name: this.title, headNodeId: id, isCurrent: true});
        } finally { this.loading = false; this.render(); }
    }
    private dropdown(): HTMLElement | null { return this.element.querySelector('.llm-branch-dropdown'); }
    private setOpen(open: boolean): void {
        const dropdown = this.dropdown(); if (!dropdown) return;
        dropdown.style.display = open ? 'block' : 'none';
        this.element.querySelector('.llm-branch-indicator-btn')?.setAttribute('aria-expanded', String(open));
        if (!open) return;
        dropdown.innerHTML = BranchIndicatorTemplates.renderDropdownItems(this.branches, {deletable: false, key: branch => branch.headNodeId});
        if (this.controls.fork) dropdown.append(this.form);
    }
    private closeDropdown(): void { this.setOpen(false); }
    destroy(): void { this.closed = true; this.events.cleanup(); }
}

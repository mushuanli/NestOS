import { FILE_ICONS, FILE_BROWSER_ICONS, fileTypeIcon, t } from '@itookit/common';
import { decorateButton, decorateResourceButton } from './controls';
import type { IEditor } from '@itookit/ui-common';
import type { WorkbenchSnapshot } from './state';
import {backToPreviousPage} from '../navigation/page-history';
import {openedButton} from './opened-button';
import {compactNavigation} from './compact-navigation';
import { Drawer } from '@itookit/vfs-ui';
import type { WorkbenchWindowBinding, WorkbenchWindow } from './windows';
import {captureEditor, restoreEditor, type EditorRecoveryState} from './recovery';

interface TabsRecovery {
    tabs: NonNullable<WorkbenchSnapshot['tabs']>;
    editors: Map<string, EditorRecoveryState>;
}

export interface WorkbenchTab<T> {
    conversationId?: string;
    context?: string;
    navigationLabel?: HTMLElement;
    location?: string;
    statusIcon?: string; statusTooltip?: string;
    icon?: string;
    id: string; title: string; pinned: boolean; preview: boolean;
    dirty: boolean; failed: boolean; panel: HTMLElement; value?: T;
    subscriptions: (() => void)[];
}
interface TabActions<T> {
    navigation?: string;
    describe?(tab: WorkbenchTab<T>): Promise<{ context?: string; location?: string }>;
    activate(id: string): Promise<void>;
    dispose(tab: WorkbenchTab<T>): Promise<void>;
    empty(): void;
    error(error: unknown): void;
    changed?(): void;
}

/** Keeps editor DOM mounted so cursor, undo history and scroll survive switching. */
export class WorkbenchTabs<T> {
    readonly opened = document.createElement('div');
    private readonly openedDrawer = new Drawer({title: t('workbench.opened'), showHeader: false, collapsible: false,
        search: {label: t('workbench.findOpened'), onChange: query => {if (this.windows) this.windows.registry.setQuery(query); else {this.openedQuery = query; this.render();}}}});
    private readonly bar = document.createElement('div');
    private readonly body = document.createElement('div');
    private readonly navigation = document.createElement('div');
    private readonly standalone: ReturnType<typeof compactNavigation>;
    private readonly emptyPanel = document.createElement('div');
    private readonly entries = new Map<string, WorkbenchTab<T>>();
    private readonly closed: { id: string; title: string }[] = [];
    private readonly selected = new Set<string>();
    private readonly metadataRevisions = new WeakMap<WorkbenchTab<T>, number>();
    private currentId?: string;
    private disposing = false;
    private opening = 0;
    private activation = 0;
    private readonly closing = new Map<string, Promise<void>>();
    private readonly abort = new AbortController();
    private readonly compactViews = new Set<ReturnType<typeof compactNavigation>>();
    private openedDialog?: HTMLDialogElement;
    private readonly windowButtons = new Set<ReturnType<typeof openedButton>>();
    private openedQuery = '';
    private describing?: Promise<void>;
    private readonly editors = new Map<WorkbenchTab<T>, IEditor>();
    private readonly recovery = new Map<string, EditorRecoveryState>();
    private readonly recoveryFailures = new Map<string, unknown>();
    private recovering = false;
    private unregisterWindows?: () => void;
    constructor(private readonly container: HTMLElement, private readonly actions: TabActions<T>, restored?: WorkbenchSnapshot['tabs'], private readonly windows?: WorkbenchWindowBinding) {
        container.classList.add('workbench-tabs'); this.bar.className = 'workbench-tabs__bar';
        this.bar.setAttribute('role', 'tablist'); this.bar.setAttribute('aria-label', t('workbench.tabs'));
        this.body.className = 'workbench-tabs__body'; this.emptyPanel.className = 'workbench-tabs__panel';
        this.opened.className = 'workbench-tabs__opened'; this.opened.append(this.openedDrawer.element); this.body.append(this.emptyPanel);
        this.navigation.className = 'workbench-tabs__navigation';
        this.standalone = compactNavigation(this.navigation, '', () => {
            const layout = container.closest<HTMLElement>('.mm-layout');
            if (layout) backToPreviousPage(() => { layout.dataset.mobileView = 'list'; });
        }, origin => this.showOpened(origin));
        container.append(this.navigation, this.bar, this.body);
        for (const tab of restored ?? []) {
            const entry = this.create(tab.id, tab.title, false); entry.pinned = tab.pinned;
            entry.context = tab.context; entry.location = tab.location; entry.conversationId = tab.conversationId;
        }
        container.addEventListener('keydown', event => this.keydown(event), { signal: this.abort.signal });
        if (windows) this.unregisterWindows = windows.registry.register(windows.id, {items: () => this.windowItems(),
            describe: () => this.describeOpened(), reopen: () => this.reopen()}, () => this.renderShared());
        this.render();
    }
    get current(): WorkbenchTab<T> | undefined { return this.currentId ? this.entries.get(this.currentId) : undefined; }
    mountCompactNavigation(container: HTMLElement, context: string, back: () => void): () => void {
        const view = compactNavigation(container, context, back, origin => this.showOpened(origin));
        this.compactViews.add(view); view.update(this.current?.title ?? '', this.windowCount());
        return () => { this.compactViews.delete(view); view.destroy(); };
    }
    mountWindowList(container: HTMLElement): () => void {
        const view = openedButton(origin => this.showOpened(origin)); container.append(view.button);
        this.windowButtons.add(view); view.update(this.windowCount());
        return () => {this.windowButtons.delete(view); view.button.remove();};
    }
    private showOpened(origin?: HTMLElement): void {
        if (this.openedDialog?.open) return;
        origin ??= document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const dialog = document.createElement('dialog'); dialog.className = 'workbench-opened-sheet';
        dialog.setAttribute('aria-label', t('workbench.opened'));
        const heading = document.createElement('strong'); heading.textContent = t('workbench.opened');
        const close = this.button(t('action.close'), () => dialog.close());
        decorateButton(close, FILE_BROWSER_ICONS.close, t('action.close'), true);
        const header = document.createElement('div'); header.className = 'workbench-opened-sheet__header'; header.append(heading, close);
        const placeholder = document.createComment('opened documents'); this.opened.before(placeholder);
        dialog.append(header, this.opened); document.body.append(dialog); this.openedDialog = dialog;
        dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
        dialog.addEventListener('close', () => {
            placeholder.replaceWith(this.opened); dialog.remove(); this.openedDialog = undefined;
            const fallback = this.current?.panel.querySelector<HTMLButtonElement>('.workbench-window-list');
            (origin?.isConnected && !origin.closest('[hidden]') ? origin : fallback)?.focus();
        }, {once: true});
        dialog.showModal();
        if (this.windows) this.windows.registry.describe(); else this.describeOpened();
    }
    private describeOpened(): void {
        if (this.describing || !this.actions.describe) return;
        const tabs = this.values().filter(tab => !tab.location);
        this.describing = Promise.all(tabs.map(async tab => {
            const id = tab.id, revision = this.metadataRevisions.get(tab);
            try {
                const info = await this.actions.describe!(tab);
                if (!this.disposing && this.get(id) === tab && this.metadataRevisions.get(tab) === revision) {
                    Object.assign(tab, info); this.render();
                }
            } catch (error) { console.warn('[WorkbenchTabs] Reading window location failed', error); }
        })).then(() => {}).finally(() => { this.describing = undefined; });
    }
    private async activateOpened(id: string): Promise<void> {
        await this.requestActivate(id);
        document.querySelectorAll<HTMLDialogElement>('.workbench-opened-sheet[open]').forEach(dialog => dialog.close());
    }
    get content(): HTMLElement { return this.current?.panel ?? this.emptyPanel; }
    get(id: string): WorkbenchTab<T> | undefined { return this.entries.get(id); }
    values(): WorkbenchTab<T>[] { return [...this.entries.values()]; }
    snapshot(): NonNullable<WorkbenchSnapshot['tabs']> {
        return this.values().filter(tab => !tab.preview).map(({ id, title, pinned, conversationId, context, location }) => ({ id, title, pinned,
            ...(conversationId ? { conversationId } : {}), ...(context ? { context } : {}), ...(location ? { location } : {}) }));
    }
    async open(id: string, title: string, preview = true): Promise<WorkbenchTab<T>> {
        ++this.opening; this.syncViewState();
        try {
            const existing = this.get(id);
            if (existing) { this.activate(id); return existing; }
            const previous = this.values().find(tab => tab.preview);
            if (previous) await this.close(previous.id, false);
            const tab = this.create(id, title, preview); this.activate(id); return tab;
        } finally { --this.opening; this.syncViewState(); }
    }
    private create(id: string, title: string, preview: boolean): WorkbenchTab<T> {
        const panel = document.createElement('div'); panel.className = 'workbench-tabs__panel'; panel.hidden = true;
        const tab: WorkbenchTab<T> = { id, title, preview, pinned: false, dirty: false, failed: false, panel, subscriptions: [] };
        this.entries.set(id, tab); this.body.append(panel); return tab;
    }
    activate(id: string): void {
        this.container.dataset.workbenchActivation = String(++this.activation);
        this.currentId = id; this.emptyPanel.hidden = true;
        for (const tab of this.values()) tab.panel.hidden = tab.id !== id;
        this.render();
    }
    keep(id: string): void { const tab = this.get(id); if (tab) { tab.preview = false; this.render(); } }
    pin(id: string): void { const tab = this.get(id); if (tab) { tab.pinned = !tab.pinned; if (tab.pinned) this.selected.delete(id); tab.preview = false; this.render(); } }
    title(id: string, title: string): void { const tab = this.get(id); if (tab && tab.title !== title) { tab.title = title; this.render(); } }
    context(id: string, context?: string): void { this.updateMetadata(id, 'context', context); }
    setNavigationLabel(id: string, label: HTMLElement): void {
        const tab = this.get(id); if (tab) { tab.navigationLabel = label; this.render(); }
    }
    location(id: string, location: string): void { this.updateMetadata(id, 'location', location); }
    private updateMetadata(id: string, field: 'context' | 'location', value?: string): void {
        const tab = this.get(id);
        if (!tab || tab[field] === value) return;
        tab[field] = value;
        this.metadataRevisions.set(tab, (this.metadataRevisions.get(tab) ?? 0) + 1);
        this.render();
    }
    setIcon(id: string, icon: string): void { const tab = this.get(id); if (tab) { tab.icon = icon; this.render(); } }
    setStatus(id: string, icon: string, tooltip: string): void {
        const tab = this.get(id);
        if (!tab || tab.statusIcon === icon && tab.statusTooltip === tooltip) return;
        tab.statusIcon = icon; tab.statusTooltip = tooltip; this.render();
    }
    rename(id: string, next: string, title: string): void {
        const tab = this.get(id); if (!tab) return;
        if (next !== id && this.get(next)) throw new Error(`Tab already open: ${next}`);
        this.metadataRevisions.set(tab, (this.metadataRevisions.get(tab) ?? 0) + 1);
        const entries = [...this.entries].map(([key, value]) => [key === id ? next : key, value] as const);
        tab.id = next; tab.title = title; this.entries.clear(); for (const [key, value] of entries) this.entries.set(key, value);
        if (next !== id && this.recovery.has(id)) {this.recovery.set(next, this.recovery.get(id)!); this.recovery.delete(id);}
        if (next !== id && this.recoveryFailures.has(id)) {this.recoveryFailures.set(next, this.recoveryFailures.get(id)); this.recoveryFailures.delete(id);}
        if (this.selected.delete(id)) this.selected.add(next);
        if (this.currentId === id) this.currentId = next;
        this.render();
    }
    bind(tab: WorkbenchTab<T>, editor?: IEditor): void {
        if (editor) {
            this.editors.set(tab, editor);
            this.restoreEditorState(tab, editor);
        }
        if (!editor?.on) return;
        tab.subscriptions.push(editor.on('interactiveChange', () => {
            tab.preview = false; tab.dirty = true; this.render();
        }), editor.on('saved', () => { tab.dirty = false; tab.failed = false; this.render(); }),
        editor.on('saveError', error => { tab.preview = false; tab.dirty = true; tab.failed = true; this.render(); this.actions.error(error); }));
    }
    private restoreEditorState(tab: WorkbenchTab<T>, editor: IEditor): void {
        const state = this.recovery.get(tab.id);
        if (!state) return;
        try {
            restoreEditor(editor, tab.panel, state); this.recovery.delete(tab.id); this.recoveryFailures.delete(tab.id);
        } catch (error) {this.recoveryFailures.set(tab.id, error); throw error;}
    }
    captureRecovery(): TabsRecovery {
        if (this.opening) throw Object.assign(new Error(t('httpApp.recoveryBusy')), {code: 'RECOVERY_BUSY'});
        const editors = new Map(this.recovery);
        for (const [tab, editor] of this.editors) if (!editors.has(tab.id)) editors.set(tab.id, captureEditor(editor, tab.panel));
        return {tabs: this.values().map(({id, title, pinned, conversationId, context, location}) =>
            ({id, title, pinned, conversationId, context, location})), editors};
    }
    restoreRecovery(snapshot: unknown): void {
        const state = snapshot as TabsRecovery;
        for (const item of state.tabs) {
            const tab = this.get(item.id) ?? this.create(item.id, item.title, false);
            Object.assign(tab, item);
        }
        for (const [id, editor] of state.editors) this.recovery.set(id, editor);
        for (const [tab, editor] of this.editors) this.restoreEditorState(tab, editor);
        this.render();
    }
    suspendForRecovery(): void { this.recovering = true; for (const editor of this.editors.values()) editor.suspendForRecovery?.(); }
    assertRecovery(): void {
        if (!this.current || !this.recovery.has(this.current.id)) return;
        if (this.recoveryFailures.has(this.current.id)) throw this.recoveryFailures.get(this.current.id);
        throw Object.assign(new Error(t('httpApp.recoveryRestorePending')), {code: 'RECOVERY_RESTORE_INCOMPLETE'});
    }
    close(id: string, record = true): Promise<void> {
        const pending = this.closing.get(id); if (pending) return pending;
        const task = this.closeNow(id, record).finally(() => this.closing.delete(id));
        this.closing.set(id, task); return task;
    }
    private async closeNow(id: string, record: boolean): Promise<void> {
        const tab = this.get(id); if (!tab) return;
        try { await this.actions.dispose(tab); }
        catch (error) { if (!this.recovering) {tab.preview = false; tab.failed = true; this.render(); throw error;} }
        tab.subscriptions.forEach(unsubscribe => unsubscribe()); tab.panel.remove(); this.entries.delete(tab.id);
        this.editors.delete(tab); this.recovery.delete(tab.id);
        this.recoveryFailures.delete(tab.id);
        this.selected.delete(tab.id);
        if (record && !tab.preview) { this.closed.push({ id: tab.id, title: tab.title }); this.windows?.registry.noteClosed(this.windows.id); }
        if (this.currentId === tab.id) {
            this.currentId = undefined; this.emptyPanel.hidden = false;
            if (record) { const next = this.values().at(-1); if (next) await this.actions.activate(next.id); else this.actions.empty(); }
        }
        this.render();
    }
    private run(task: Promise<unknown>): void { void task.catch(error => {this.windows?.registry.report(error); this.actions.error(error);}); }
    private button(label: string, action: () => void, className = ''): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.className = className; button.title = label; button.setAttribute('aria-label', label); button.onclick = action; return button;
    }
    private render(): void {
        this.renderShared();
        if (!this.disposing) { this.actions.changed?.(); this.windows?.registry.changed(); }
    }
    private renderShared(): void {
        this.syncViewState();
        this.standalone.update(this.current?.title ?? '', this.windowCount(), this.current?.context, this.current?.navigationLabel);
        for (const view of this.windowButtons) view.update(this.windowCount());
        for (const view of this.compactViews) view.update(this.current?.title ?? '', this.windowCount());
        this.bar.replaceChildren(); this.openedDrawer.content.replaceChildren();
        if (this.windows?.registry.error) {
            const notice = document.createElement('p'); notice.setAttribute('role', 'alert'); notice.className = 'workbench-tabs__error';
            notice.textContent = this.windows.registry.error; notice.append(this.button(t('action.close'), () => this.windows?.registry.clearError()));
            this.openedDrawer.content.append(notice);
        }
        this.openedDrawer.content.append(this.openedToolbar());
        if (this.windows) this.renderWindows();
        else {
            const tabs = this.values().sort((a, b) => Number(b.pinned) - Number(a.pinned));
            for (const tab of tabs) { this.bar.append(this.tabHeader(tab)); this.openedDrawer.content.append(this.openedRow(tab)); }
            this.filterOpened();
        }
        const menu = document.createElement('details'); menu.className = 'workbench-tabs__menu';
        const summary = document.createElement('summary'); summary.innerHTML = FILE_BROWSER_ICONS.more; summary.title = t('workbench.tabActions'); summary.setAttribute('aria-label', summary.title); menu.append(summary);
        const popup = document.createElement('div'); popup.className = 'workbench-tabs__menu-panel';
        popup.append(this.button(t('workbench.closeSaved'), () => this.run(this.windows?.registry.closeSaved() ?? this.closeSaved())),
            this.button(t('workbench.reopen'), () => this.run(this.windows?.registry.reopen() ?? this.reopen())));
        menu.append(popup); menu.ontoggle = () => { popup.style.top = `${summary.getBoundingClientRect().bottom + 6}px`; };
        popup.onclick = () => { menu.open = false; };
        this.bar.append(menu);
    }
    private windowCount(): number { return this.windows?.registry.items().length ?? this.entries.size; }
    private isCurrent(id: string): boolean { return id === this.currentId && (!this.windows || this.windows.isActive()); }
    private requestActivate(id: string): Promise<void> {
        return this.windows && !this.windows.isActive() ? this.windows.navigate(id) : this.actions.activate(id);
    }
    private windowItems(): WorkbenchWindow[] {
        return this.values().map(tab => ({id: tab.id, title: tab.title, scope: this.actions.navigation,
            context: tab.context, location: tab.location, pinned: tab.pinned, dirty: tab.dirty, failed: tab.failed,
            selected: this.selected.has(tab.id), active: this.isCurrent(tab.id), activate: () => this.requestActivate(tab.id), header: () => this.tabHeader(tab), row: () => this.openedRow(tab),
            select: selected => { if (selected) this.selected.add(tab.id); else this.selected.delete(tab.id); },
            close: () => this.close(tab.id)}));
    }
    private renderWindows(): void {
        const registry = this.windows!.registry;
        this.openedDrawer.setQuery(registry.query);
        for (const item of registry.items()) {
            this.bar.append(item.header()); const row = item.row(); row.hidden = !registry.matches(item);
            this.openedDrawer.content.append(row);
        }
    }
    private sharedOpenedToolbar(): HTMLElement {
        const registry = this.windows!.registry, eligible = registry.items().filter(item => !item.pinned && registry.matches(item));
        const bar = document.createElement('div'); bar.className = 'workbench-tabs__opened-toolbar';
        const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', t('workbench.selectAllOpened'));
        all.checked = !!eligible.length && eligible.every(item => item.selected);
        all.indeterminate = !all.checked && eligible.some(item => item.selected); all.disabled = !eligible.length;
        all.onchange = () => registry.selectAll(all.checked);
        const label = document.createElement('label'); label.append(all, document.createTextNode(t('workbench.selectAllOpened')));
        const close = this.button(t('workbench.closeSelected'), () => this.run(registry.closeSelected()));
        close.dataset.action = 'close-selected-tabs'; const count = registry.items().filter(item => item.selected).length;
        decorateButton(close, FILE_BROWSER_ICONS.close, `${t('workbench.closeSelected')} (${count})`, true); close.disabled = !count;
        bar.append(label, close); return bar;
    }
    private tabHeader(tab: WorkbenchTab<T>): HTMLElement {
        const header = document.createElement('div'); header.className = 'workbench-tabs__tab'; header.dataset.tabId = tab.id;
        header.classList.toggle('is-active', this.isCurrent(tab.id)); header.classList.toggle('is-preview', tab.preview);
        const label = this.button(tab.title, () => this.run(this.requestActivate(tab.id)), 'workbench-tabs__label');
        label.setAttribute('role', 'tab'); label.setAttribute('aria-selected', String(this.isCurrent(tab.id)));
        decorateResourceButton(label, tab.icon ?? fileTypeIcon(tab.title), tab.title);
        label.title = tab.statusTooltip ?? tab.id; label.ondblclick = () => this.keep(tab.id);
        const state = document.createElement('span'); state.className = 'workbench-tabs__state';
        state.title = tab.failed ? t('workbench.saveFailed') : tab.dirty ? t('workbench.pending') : tab.preview ? t('workbench.preview') : '';
        state.textContent = tab.failed ? '!' : tab.dirty ? '•' : '';
        state.setAttribute('aria-label', state.title);
        if (tab.statusIcon) {
            const status = document.createElement('span'); status.className = 'workbench-tabs__state';
            status.textContent = tab.statusIcon; status.title = tab.statusTooltip ?? ''; status.setAttribute('aria-label', status.title); header.append(status);
        }
        if (tab.context) header.append(this.contextLabel(tab.context));
        header.append(label, state, this.button(t(tab.pinned ? 'workbench.unpin' : 'workbench.pin'), () => this.pin(tab.id), 'workbench-tabs__pin'),
            this.button(t('workbench.close'), () => this.run(this.close(tab.id)), 'workbench-tabs__close'));
        decorateButton(header.querySelector<HTMLButtonElement>('.workbench-tabs__close')!, FILE_BROWSER_ICONS.close, t('workbench.close'), true);
        const pin = header.querySelector<HTMLButtonElement>('.workbench-tabs__pin')!;
        decorateButton(pin, FILE_ICONS.pin, t(tab.pinned ? 'workbench.unpin' : 'workbench.pin'), true); pin.setAttribute('aria-pressed', String(tab.pinned));
        if (tab.preview) header.append(decorateButton(this.button(t('workbench.keep'), () => this.keep(tab.id), 'workbench-tabs__keep'), FILE_BROWSER_ICONS.keep, t('workbench.keep'), true));
        return header;
    }
    private openedRow(tab: WorkbenchTab<T>): HTMLElement {
        const row = document.createElement('div'); row.className = 'workbench-tabs__opened-row'; row.dataset.openedId = tab.id;
        row.classList.toggle('is-active', this.isCurrent(tab.id));
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.selected.has(tab.id); checkbox.disabled = tab.pinned;
        checkbox.setAttribute('aria-label', `${t('workbench.select')} ${tab.title}`);
        checkbox.onchange = () => { checkbox.checked ? this.selected.add(tab.id) : this.selected.delete(tab.id); this.render(); };
        const label = this.button(tab.title, () => this.run(this.activateOpened(tab.id))); label.title = tab.id;
        decorateResourceButton(label, tab.icon ?? fileTypeIcon(tab.title), tab.title); label.className = 'workbench-tabs__opened-label'; label.title = tab.id;
        this.openedLabel(label, tab);
        label.setAttribute('aria-current', String(this.isCurrent(tab.id)));
        const pin = decorateButton(this.button(t(tab.pinned ? 'workbench.unpin' : 'workbench.pin'), () => this.pin(tab.id)), FILE_ICONS.pin, t(tab.pinned ? 'workbench.unpin' : 'workbench.pin'), true);
        pin.className = 'workbench-tabs__opened-pin'; pin.setAttribute('aria-pressed', String(tab.pinned));
        row.append(checkbox);
        row.append(label, pin, decorateButton(this.button(t('workbench.close'), () => this.run(this.close(tab.id))), FILE_BROWSER_ICONS.close, t('workbench.close'), true)); return row;
    }
    private openedLabel(label: HTMLButtonElement, tab: WorkbenchTab<T>): void {
        const text = label.lastElementChild!; text.className = 'workbench-tabs__opened-text';
        const title = document.createElement('span'); title.textContent = tab.title; text.replaceChildren(title);
        const context = [this.actions.navigation, tab.context, tab.location].filter(Boolean).join(' · ');
        if (context) {
            const location = document.createElement('small'); location.textContent = context; text.append(location);
            label.title = context; label.setAttribute('aria-label', `${tab.title} — ${context}`);
        }
    }
    private filterOpened(): void {
        for (const row of this.opened.querySelectorAll<HTMLElement>('[data-opened-id]')) {
            const tab = this.get(row.dataset.openedId!);
            row.hidden = !tab || !this.matchesOpened(tab);
        }
    }
    private matchesOpened(tab: WorkbenchTab<T>): boolean {
        return [this.actions.navigation, tab.title, tab.context, tab.location].filter(Boolean).join('\n')
            .toLocaleLowerCase().includes(this.openedQuery.trim().toLocaleLowerCase());
    }
    private contextLabel(context: string): HTMLElement {
        const label = document.createElement('span'); label.className = 'workbench-tabs__context';
        label.textContent = context; label.title = context; return label;
    }
    private syncViewState(): void { this.container.dataset.workbenchView = this.opening ? 'opening' : this.currentId ? 'active' : 'empty'; }
    private openedToolbar(): HTMLElement {
        if (this.windows) return this.sharedOpenedToolbar();
        const bar = document.createElement('div'); bar.className = 'workbench-tabs__opened-toolbar';
        const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', t('workbench.selectAllOpened'));
        const eligible = this.values().filter(tab => !tab.pinned && this.matchesOpened(tab));
        all.checked = eligible.length > 0 && eligible.every(tab => this.selected.has(tab.id));
        all.indeterminate = !all.checked && eligible.some(tab => this.selected.has(tab.id)); all.disabled = !eligible.length;
        all.onchange = () => { eligible.forEach(tab => {if (all.checked) this.selected.add(tab.id); else this.selected.delete(tab.id);}); this.render(); };
        const label = document.createElement('label'); label.append(all, document.createTextNode(t('workbench.selectAllOpened')));
        const close = this.button(t('workbench.closeSelected'), () => this.run(this.closeSelected())); close.dataset.action = 'close-selected-tabs';
        decorateButton(close, FILE_BROWSER_ICONS.close, `${t('workbench.closeSelected')} (${this.selected.size})`, true); close.disabled = !this.selected.size;
        bar.append(label, close); return bar;
    }
    private async closeSelected(): Promise<void> {
        let failure: unknown;
        for (const id of [...this.selected]) if (!this.get(id)?.pinned) {
            try { await this.close(id); } catch (error) { failure = error; }
        }
        if (failure) throw failure;
    }
    private async closeSaved(): Promise<void> {
        for (const tab of this.values()) if (!tab.pinned && !tab.dirty && !tab.failed) await this.close(tab.id);
    }
    private async reopen(): Promise<void> {
        const tab = this.closed.pop(); if (!tab) return;
        await this.requestActivate(tab.id); this.keep(tab.id);
    }
    private keydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            const menu = this.bar.querySelector<HTMLDetailsElement>('details[open]');
            if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); event.preventDefault(); }
        }
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key === 'Tab') {
            event.preventDefault();
            if (this.windows) {this.run(this.windows.registry.cycle(event.shiftKey ? -1 : 1)); return;}
            const tabs = this.values(), index = tabs.findIndex(tab => tab.id === this.currentId);
            const next = tabs[(index + (event.shiftKey ? tabs.length - 1 : 1)) % tabs.length];
            if (next) this.run(this.actions.activate(next.id));
        } else if (event.shiftKey && event.key.toLowerCase() === 't') {
            event.preventDefault(); this.run(this.windows?.registry.reopen() ?? this.reopen());
        }
    }
    async destroy(): Promise<void> {
        this.openedDialog?.close();
        this.unregisterWindows?.(); this.unregisterWindows = undefined;
        this.disposing = true;
        for (const tab of this.values()) await this.close(tab.id, false);
        for (const view of this.windowButtons) view.button.remove(); this.windowButtons.clear();
        this.abort.abort(); this.openedDrawer.destroy(); this.standalone.destroy(); this.navigation.remove(); this.bar.remove(); this.body.remove(); this.opened.remove(); this.container.classList.remove('workbench-tabs');
        delete this.container.dataset.workbenchView;
        delete this.container.dataset.workbenchActivation;
    }
}

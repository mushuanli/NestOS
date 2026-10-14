import { showNameDialog } from '../files/project-dialog';
import { getLocale, t } from '@itookit/common';
import { installResponsiveActions } from '@itookit/ui-common';
import type { ProjectSessions } from '@itookit/app-contracts/services';
import type { ConversationManifest, SessionSummary } from '@itookit/llm-session/contracts';

interface Actions {
    open(id: string): Promise<void>; child(id: string): Promise<unknown>; remove(id: string): Promise<void>;
    changed(): Promise<void>; showFamily(): void; report(error: unknown): void;
}

/** Small, explicit organization actions; every member keeps an independent editor. */
export class SessionFamilyActions {
    private headerEvents?: AbortController;
    private currentHeader?: HTMLElement;
    private readonly controllers = new Map<HTMLElement, AbortController>();
    constructor(private readonly sessions: ProjectSessions,
        private readonly signal: AbortSignal, private readonly actions: Actions) { signal.addEventListener('abort', () => { for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear(); }, { once: true }); }
    async header(manifest: ConversationManifest): Promise<HTMLElement> {
        const { members } = await this.sessions.family(manifest.id);
        const header = document.createElement('div'); header.className = 'session-family__toolbar';
        header.dataset.sessionId = manifest.id; this.currentHeader = header;
        const primary = document.createElement('div'); primary.className = 'session-family__primary';
        const menu = document.createElement('details'); menu.className = 'session-family__menu';
        const summary = document.createElement('summary'); summary.textContent = t('project.sessionActions');
        const items = document.createElement('div'); items.className = 'session-family__menu-items';
        items.append(this.information()); menu.append(summary, items); header.append(primary, menu);
        this.bindMenu(menu); this.controllers.set(header, this.headerEvents!); this.updateMetadata(manifest);
        const actions = this.headerActions(manifest, members).map(action => {
            const button = this.button(action.label, async () => { menu.open = false; await action.run(); });
            items.append(button); return { button, primary: action.primary };
        });
        const dispose = installResponsiveActions({ container: header, toolbar: primary, fallbackFocus: summary,
            actions: actions.filter(action => action.primary).map(action => action.button), minWidth: 640 });
        this.headerEvents!.signal.addEventListener('abort', dispose, { once: true });
        menu.addEventListener('toggle', () => {
            if (menu.open) void this.sessions.get(manifest.id).then(current => {
                if (!this.signal.aborted && this.currentHeader === header) this.updateMetadata(current);
            }).catch(this.actions.report);
        }, { signal: this.headerEvents!.signal });
        if (manifest.parentSessionId && !manifest.currentHead) {
            const hint = document.createElement('span'); hint.className = 'session-family__hint'; hint.textContent = t('project.independentSession'); header.append(hint);
        }
        return header;
    }
    private headerActions(manifest: ConversationManifest, members: SessionSummary[]) {
        const actions: Array<{ label: string; primary?: boolean; run: () => Promise<unknown> }> = [];
        const parent = members.find(item => item.id === manifest.parentSessionId);
        if (parent) actions.push({ label: t('project.parentSession', { name: parent.title }), primary: true, run: () => this.actions.open(parent.id) });
        if (members.length > 1) actions.push({ label: t('project.family'), primary: true, run: async () => {
            if (window.matchMedia?.('(max-width: 768px)').matches) await this.showFamily(manifest.id);
            else this.actions.showFamily();
        } });
        actions.push({ label: t('project.newChild'), primary: true, run: () => this.actions.child(manifest.id) },
            { label: t('project.renameSession'), run: () => this.rename(manifest.id) },
            { label: t('project.moveUnder'), run: () => this.move(manifest.id) });
        if (parent) actions.push({ label: t('project.promoteSession'), run: () => this.promote(manifest.id) });
        actions.push({ label: t('project.deleteSessionOnly'), run: () => this.remove(manifest.id) });
        return actions;
    }
    private information(): HTMLElement {
        const info = document.createElement('dl'); info.className = 'session-family__information';
        for (const field of ['createdAt', 'updatedAt'] as const) {
            const label = document.createElement('dt'); label.textContent = t(field === 'createdAt' ? 'project.createdAt' : 'project.lastActivity');
            const value = document.createElement('dd'), time = document.createElement('time'); time.dataset.sessionTime = field;
            value.append(time); info.append(label, value);
        }
        const hint = document.createElement('small'); hint.textContent = t('project.activityHint');
        const wrapper = document.createElement('div'); wrapper.className = 'session-family__metadata'; wrapper.append(info, hint); return wrapper;
    }
    activate(header: HTMLElement | null): void { this.currentHeader = header ?? undefined; }
    release(header: HTMLElement | null): void {
        if (!header) return;
        this.controllers.get(header)?.abort(); this.controllers.delete(header);
        if (this.currentHeader === header) this.currentHeader = undefined;
    }
    updateMetadata(manifest: ConversationManifest): void {
        if (this.currentHeader?.dataset.sessionId !== manifest.id) return;
        for (const time of this.currentHeader.querySelectorAll<HTMLTimeElement>('time[data-session-time]')) {
            const value = manifest[time.dataset.sessionTime as 'createdAt' | 'updatedAt'];
            const date = new Date(value);
            time.textContent = Number.isFinite(date.getTime())
                ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'medium' }).format(date) : t('project.timeUnknown');
            if (Number.isFinite(date.getTime())) { time.dateTime = date.toISOString(); time.title = date.toLocaleString(getLocale()); }
            else { time.removeAttribute('datetime'); time.removeAttribute('title'); }
        }
    }
    private bindMenu(menu: HTMLDetailsElement): void {
        this.headerEvents = new AbortController();
        const signal = this.headerEvents.signal;
        document.addEventListener('click', event => { if (!menu.contains(event.target as Node)) menu.open = false; }, { signal });
        menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary')?.focus(); } }, { signal });
    }
    private async rename(id: string): Promise<void> {
        const session = await this.sessions.get(id);
        await showNameDialog(t('project.renameSession'), t('project.sessionName'), this.signal, async title => {
            await this.sessions.rename(id, title); await this.actions.changed(); await this.actions.open(id);
        }, undefined, { initialName: session.title, confirmLabel: t('project.save') });
    }
    private button(label: string, run: () => Promise<unknown>): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.onclick = () => { button.disabled = true; void run().catch(this.actions.report).finally(() => { button.disabled = false; }); };
        return button;
    }
    async promote(id: string): Promise<void> {
        await this.sessions.reparent(id, null); await this.actions.changed(); await this.actions.open(id);
    }
    async move(id: string): Promise<void> {
        const candidates = await this.sessions.moveCandidates(id);
        await this.picker(t('project.moveUnder'), candidates, async parent => {
            await this.sessions.reparent(id, parent);
            await this.actions.changed(); await this.actions.open(id);
        });
    }
    async showFamily(id: string): Promise<void> {
        const { members } = await this.sessions.family(id);
        await this.picker(t('project.family'), members, selected => this.actions.open(selected), id);
    }
    async remove(id: string): Promise<void> {
        const session = await this.sessions.get(id);
        if (!window.confirm(t('project.deleteSessionConfirm', { name: session.title }))) return;
        await this.actions.remove(id);
    }
    private picker(title: string, sessions: SessionSummary[], select: (id: string) => Promise<void>, active?: string): Promise<void> {
        if (this.signal.aborted) return Promise.resolve();
        return new Promise(resolve => {
            const previous = document.activeElement as HTMLElement | null;
            const dialog = document.createElement('dialog'); dialog.className = 'project-dialog session-family__picker'; dialog.setAttribute('aria-label', title);
            const heading = document.createElement('h2'); heading.textContent = title;
            const search = document.createElement('input'); search.type = 'search'; search.placeholder = t('project.searchContents'); search.setAttribute('aria-label', search.placeholder);
            const list = document.createElement('div'); list.className = 'session-family__choices';
            const status = document.createElement('p'); status.setAttribute('role', 'alert');
            const close = () => { dialog.close(); dialog.remove(); this.signal.removeEventListener('abort', close); previous?.focus(); resolve(); };
            const render = () => this.renderChoices(list, sessions, search.value, active, async id => {
                try { await select(id); close(); } catch (error) { status.textContent = (error as Error).message; }
            });
            search.oninput = render;
            dialog.oncancel = event => { event.preventDefault(); close(); };
            dialog.append(heading, search, list, status, this.button(t('project.cancel'), async () => close()));
            this.signal.addEventListener('abort', close, { once: true }); document.body.append(dialog); render(); dialog.showModal();
            (list.querySelector<HTMLElement>('[aria-current="true"]') ?? search).focus();
        });
    }
    private renderChoices(list: HTMLElement, sessions: SessionSummary[], query: string, active: string | undefined,
        select: (id: string) => Promise<void>): void {
        list.replaceChildren();
        const names = new Map(sessions.map(item => [item.id, item.title]));
        for (const session of sessions) {
            const parent = session.parentSessionId && names.get(session.parentSessionId);
            const label = parent ? `${session.title} · ${t('project.parentSession', { name: parent })}` : session.title;
            if (!label.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
            const button = this.button(label, () => select(session.id));
            button.setAttribute('aria-current', String(session.id === active)); list.append(button);
        }
        if (!list.childElementCount) list.textContent = t('project.noSessions');
    }
}

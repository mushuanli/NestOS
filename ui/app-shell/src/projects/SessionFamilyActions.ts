import { showNameDialog } from '../files/project-dialog';
import { t } from '@itookit/common';
import { setTimePresentation } from '@itookit/ui-common';
import type { ProjectSessions } from '@itookit/app-contracts/services';
import type { ConversationManifest, SessionSummary } from '@itookit/llm-session/contracts';

interface Actions {
    open(id: string): Promise<void>; child(id: string): Promise<unknown>; remove(id: string): Promise<void>;
    childWithMaterial?(id: string): Promise<unknown>;
    changed(): Promise<void>; report(error: unknown): void;
}

/** Small, explicit organization actions; every member keeps an independent editor. */
export class SessionFamilyActions {
    private currentHeader?: HTMLElement;
    private readonly controllers = new Map<HTMLElement, AbortController>();
    constructor(private readonly sessions: ProjectSessions,
        private readonly signal: AbortSignal, private readonly actions: Actions) { signal.addEventListener('abort', () => { for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear(); }, { once: true }); }
    mount(container: HTMLElement, manifest: ConversationManifest): () => void {
        const section = document.createElement('div'); section.className = 'session-family__section';
        section.dataset.sessionId = manifest.id; this.currentHeader = section;
        const events = new AbortController(); this.controllers.set(section, events);
        const heading = document.createElement('strong'); heading.textContent = t('project.sessionActions');
        const hint = document.createElement('small'); hint.textContent = t(manifest.initialContext ? 'project.childInitialMaterial' : 'project.relatedSessionHint');
        const metadata = this.information();
        section.append(heading, metadata, hint);
        for (const action of this.headerActions(manifest)) section.append(this.button(action.label, action.run));
        container.prepend(section); this.updateMetadata(manifest);
        this.bindMetadataRefresh(section, metadata, manifest.id, events.signal);
        return () => { this.release(section); section.remove(); };
    }
    private bindMetadataRefresh(section: HTMLElement, metadata: HTMLDetailsElement, id: string, signal: AbortSignal): void {
        const status = document.createElement('p'); status.className = 'session-family__metadata-status';
        status.setAttribute('role', 'alert'); status.hidden = true; metadata.append(status);
        let pending = false;
        metadata.addEventListener('toggle', async () => {
            if (!metadata.open || pending || signal.aborted) return;
            pending = true; metadata.setAttribute('aria-busy', 'true');
            try {
                const current = await this.sessions.get(id);
                if (signal.aborted) return;
                this.renderMetadata(section, current); status.hidden = true; status.textContent = '';
            } catch (error) {
                if (signal.aborted) return;
                const message = error instanceof Error ? error.message : String(error);
                status.textContent = t('project.sessionInfoRefreshFailed', { message }); status.hidden = false;
                console.warn('[SessionFamilyActions] Refreshing conversation information failed', error);
            } finally { pending = false; metadata.removeAttribute('aria-busy'); }
        }, { signal });
    }
    private headerActions(manifest: ConversationManifest) {
        const actions: Array<{label: string; run: () => Promise<unknown>}> = [];
        if (manifest.parentSessionId) actions.push({label: t('project.openParent'), run: () => this.actions.open(manifest.parentSessionId!)});
        actions.push({label: t('project.family'), run: () => this.showFamily(manifest.id)},
            {label: t('project.newChild'), run: () => this.actions.child(manifest.id)},
            {label: t('project.renameSession'), run: () => this.rename(manifest.id)},
            {label: t('project.moveUnder'), run: () => this.move(manifest.id)});
        if (manifest.parentSessionId) actions.push({label: t('project.promoteSession'), run: () => this.promote(manifest.id)});
        actions.push({label: t('project.deleteSessionOnly'), run: () => this.remove(manifest.id)});
        if (this.actions.childWithMaterial) actions.splice(manifest.parentSessionId ? 3 : 2, 0, {label: t('project.createChildWithMaterial'), run: () => this.actions.childWithMaterial!(manifest.id)});
        return actions;
    }
    private information(): HTMLDetailsElement {
        const info = document.createElement('dl'); info.className = 'session-family__information';
        for (const field of ['createdAt', 'updatedAt'] as const) {
            const label = document.createElement('dt'); label.textContent = t(field === 'createdAt' ? 'project.createdAt' : 'project.lastActivity');
            const value = document.createElement('dd'), time = document.createElement('time'); time.dataset.sessionTime = field;
            value.append(time); info.append(label, value);
        }
        const hint = document.createElement('small'); hint.textContent = t('project.activityHint');
        const wrapper = document.createElement('details'); wrapper.className = 'session-family__metadata';
        const summary = document.createElement('summary'); summary.textContent = t('project.sessionInfo');
        wrapper.append(summary, info, hint); return wrapper;
    }
    activate(header: HTMLElement | null): void { this.currentHeader = header ?? undefined; }
    release(header: HTMLElement | null): void {
        if (!header) return;
        this.controllers.get(header)?.abort(); this.controllers.delete(header);
        if (this.currentHeader === header) this.currentHeader = undefined;
    }
    updateMetadata(manifest: ConversationManifest): void {
        if (this.currentHeader?.dataset.sessionId !== manifest.id) return;
        this.renderMetadata(this.currentHeader, manifest);
    }
    private renderMetadata(section: HTMLElement, manifest: ConversationManifest): void {
        for (const time of section.querySelectorAll<HTMLTimeElement>('time[data-session-time]')) {
            const value = manifest[time.dataset.sessionTime as 'createdAt' | 'updatedAt'];
            setTimePresentation(time, value, t('project.timeUnknown'));
        }
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

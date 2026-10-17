import { t } from '@itookit/common';
import type { HarnessClient, HarnessProfile, HarnessSession, HarnessEvents } from '@itookit/app-contracts/services';
import { historyText } from './history';
import { renderInteraction } from './interactions';

/** Closing the viewer releases transport only; interruption is an explicit command. */
export async function showHarnessControl(client: HarnessClient, name: string, signal: AbortSignal): Promise<void> {
    const control = new HarnessControl(client,name,signal);
    try { await control.open(); } finally { await client.close(); }
}

class HarnessControl {
    private readonly lifetime = new AbortController();
    private readonly dialog = document.createElement('dialog');
    private readonly profile = document.createElement('select');
    private readonly workspace = document.createElement('select');
    private readonly archived = document.createElement('input');
    private readonly sessions = document.createElement('div');
    private readonly output = document.createElement('pre');
    private readonly interactions = document.createElement('div');
    private readonly prompt = document.createElement('textarea');
    private readonly status = document.createElement('p');
    private readonly send = document.createElement('button');
    private readonly interrupt = document.createElement('button');
    private profiles: HarnessProfile[] = [];
    private selected?: HarnessSession;
    private owned = false;
    private turnId?: string;
    private cursor?: { after: number; eventEpoch: string };
    private nextCursor?: string;
    private generation = 0;
    private listGeneration = 0;
    private readonly completedTurns = new Set<string>();
    private polling = false;
    private pollError?: string;
    private submitting = false;
    private interactionKey = '';
    private pending?: { requestId: string; profileId: string; sessionId?: string };
    private resolve?: () => void;
    constructor(private readonly client: HarnessClient, private readonly name: string, private readonly signal: AbortSignal) {}

    async open(): Promise<void> {
        if (this.signal.aborted) return;
        this.layout(); document.body.append(this.dialog); this.dialog.showModal();
        const closed = new Promise<void>(resolve => { this.resolve = resolve; });
        this.signal.addEventListener('abort',this.close,{ once: true });
        await this.run(async () => {
            const result = await this.client.profiles(this.options());
            this.profiles = result.profiles;
            this.profile.replaceChildren(...this.profiles.map(p => option(p.id,`${p.kind} · ${p.id}`)));
            if (!this.profiles.length) this.status.textContent = t('harness.emptyProfiles');
            else await this.changeProfile();
        });
        await closed;
    }
    private readonly close = () => {
        this.lifetime.abort(); this.signal.removeEventListener('abort',this.close);
        this.dialog.close(); this.dialog.remove(); this.resolve?.();
    };
    private options() { return { signal: this.lifetime.signal, timeoutMs: 30_000 }; }
    private layout() {
        this.dialog.className = 'harness-control'; this.dialog.setAttribute('aria-label',t('harness.title'));
        const title = document.createElement('h2'); title.textContent = `${t('harness.title')} · ${this.name}`;
        const hint = document.createElement('p'); hint.textContent = t('harness.hint');
        const toolbar = this.toolbar(), body = document.createElement('div'); body.className = 'harness-control__body';
        this.sessions.className = 'harness-control__sessions'; this.output.className = 'harness-control__output';
        this.output.setAttribute('aria-label',t('harness.history')); this.output.tabIndex = 0;
        const detail = document.createElement('div'); detail.className = 'harness-control__detail'; detail.append(this.output,this.interactions);
        body.append(this.sessions,detail); this.status.setAttribute('role','status');
        this.dialog.append(title,hint,toolbar,body,this.messageForm(),this.status);
        this.button(this.dialog,t('harness.close'),async () => this.close());
        this.dialog.oncancel = event => { event.preventDefault(); this.close(); };
    }
    private toolbar() {
        const toolbar = document.createElement('div'); toolbar.className = 'harness-control__toolbar';
        this.profile.setAttribute('aria-label',t('harness.profile')); this.workspace.setAttribute('aria-label',t('harness.workspace'));
        this.profile.onchange = () => { void this.run(() => this.changeProfile()); };
        this.archived.type = 'checkbox'; this.archived.onchange = () => { void this.run(() => this.loadSessions()); };
        const archive = document.createElement('label'); archive.textContent = t('harness.archived'); archive.append(this.archived);
        toolbar.append(this.profile,this.workspace,archive);
        this.button(toolbar,t('harness.refresh'),() => this.loadSessions());
        this.button(toolbar,t('harness.create'),async () => {
            if (this.pending || this.submitting || this.turnId) throw new Error(t('harness.unknown'));
            this.submitting = true; this.updateControls();
            try {
                const result = await this.client.create(this.profile.value,this.workspace.value,this.options());
                await this.select(result.session,true); await this.loadSessions();
            } finally { this.submitting = false; this.updateControls(); }
        });
        this.button(toolbar,t('harness.reconcile'),() => this.reconcile());
        return toolbar;
    }
    private messageForm() {
        const form = document.createElement('form'); form.className = 'harness-control__form';
        this.prompt.setAttribute('aria-label',t('harness.prompt')); this.prompt.placeholder = t('harness.prompt');
        this.send.type = 'submit'; this.send.textContent = t('harness.send'); this.send.disabled = true;
        this.interrupt.type = 'button'; this.interrupt.textContent = t('harness.interrupt'); this.interrupt.disabled = true;
        this.interrupt.onclick = () => { void this.run(async () => {
            if (this.selected && this.turnId) await this.client.interrupt(this.profile.value,this.selected.id,this.turnId,this.options());
        }); };
        form.onsubmit = event => { event.preventDefault(); if (!this.send.disabled) void this.run(() => this.startTurn()); };
        form.append(this.prompt,this.send,this.interrupt); return form;
    }
    private async changeProfile() {
        this.generation++; this.completedTurns.clear(); this.selected = undefined; this.owned = false; this.turnId = undefined; this.cursor = undefined;
        this.pending = undefined; this.output.textContent = ''; this.interactions.replaceChildren(); this.interactionKey = ''; this.updateControls();
        const profile = this.profiles.find(p => p.id === this.profile.value);
        this.workspace.replaceChildren(...(profile?.workspaces ?? []).map(w => option(w.id,w.id)));
        await this.loadSessions();
        if (!this.polling) { this.polling = true; void this.poll(); }
    }
    private async loadSessions(cursor?: string) {
        const generation = this.generation, listGeneration = ++this.listGeneration, profile = this.profile.value;
        if (!profile) return;
        const page = await this.client.list(profile,{ cursor,archived:this.archived.checked },this.options());
        if (generation !== this.generation || listGeneration !== this.listGeneration || this.lifetime.signal.aborted) return;
        if (!cursor) this.sessions.replaceChildren();
        this.sessions.querySelector('[data-more]')?.remove();
        for (const session of page.sessions) this.sessionButton(session);
        this.nextCursor = page.nextCursor ?? undefined;
        if (this.nextCursor) this.button(this.sessions,t('harness.more'),() => this.loadSessions(this.nextCursor)).dataset.more = '';
        if (!page.sessions.length && !cursor) this.sessions.textContent = t('harness.emptySessions');
    }
    private sessionButton(session: HarnessSession) {
        const button = this.button(this.sessions,session.title || session.id,() => this.select(session,false));
        button.title = `${session.cwd ?? ''}\n${session.status ?? ''}`;
        button.dataset.sessionId = session.id;
    }
    private async select(session: HarnessSession, owned: boolean) {
        if (this.submitting && !owned) return;
        const generation = ++this.generation; this.selected = session; this.owned = owned; this.turnId = undefined;
        this.output.textContent = t('harness.loading'); this.interactions.replaceChildren(); this.interactionKey = ''; this.updateControls();
        const history = await this.client.read(this.profile.value,session.id,this.options());
        if (generation !== this.generation || this.lifetime.signal.aborted) return;
        this.output.textContent = historyText(history.turns); this.selected = history.session;
        this.owned = history.session.owned ?? owned; this.turnId = history.session.activeTurnId ?? undefined; this.updateControls();
        if (!history.session.resumable) this.status.textContent = t('harness.historyOnly');
    }
    private async startTurn() {
        if (!this.selected || !this.prompt.value.trim() || this.pending || this.submitting) return;
        this.submitting = true; this.updateControls();
        try {
            if (!this.owned) { await this.client.resume(this.profile.value,this.selected.id,this.options()); this.owned = true; }
            const text = this.prompt.value;
            const result = await this.client.turn(this.profile.value,this.selected.id,text,this.options());
            this.turnId = this.completedTurns.has(result.turnId) ? undefined : result.turnId; this.prompt.value = ''; this.append(`\n\n${text}\n`);
        } finally { this.submitting = false; this.updateControls(); }
    }
    private async poll() {
        while (!this.lifetime.signal.aborted) {
            const profile = this.profile.value;
            try {
                if (profile) {
                    const page = await this.client.events(profile,this.cursor,this.options());
                    if (profile === this.profile.value && !this.lifetime.signal.aborted) {
                        if (this.status.textContent === this.pollError) this.status.textContent = '';
                        this.pollError = undefined; this.consume(page);
                    }
                }
            } catch (error) {
                if (!this.lifetime.signal.aborted) {
                    console.error('[Harness] Update failed', error);
                    this.pollError = t('harness.updateFailed', {message: error instanceof Error ? error.message : t('harness.failed')});
                    this.status.textContent = this.pollError;
                }
            }
            await pause(this.lifetime.signal);
        }
    }
    private consume(page: HarnessEvents) {
        this.cursor = { after: page.cursor,eventEpoch:page.epoch };
        if (page.gap) this.status.textContent = t('harness.eventGap');
        for (const event of page.events) {
            const { method,params } = event.message;
            if (method === 'harness/disconnected' && (!params?.threadId || params.threadId === this.selected?.id)) this.status.textContent = t('harness.disconnected');
            if (params?.threadId !== this.selected?.id) continue;
            if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') this.append(params.delta);
            if (method === 'turn/started' || method === 'turn/completed') this.consumeTurn(method,params?.turn);
        }
        this.renderRequests(page);
        this.updateControls();
    }
    private consumeTurn(method: string, value: unknown) {
        const id = (value as { id?: string } | undefined)?.id;
        if (!id) return;
        if (method === 'turn/started') {
            if (!this.completedTurns.has(id)) this.turnId = id;
            return;
        }
        this.completedTurns.add(id);
        if (this.completedTurns.size > 1024) this.completedTurns.delete(this.completedTurns.values().next().value!);
        if (this.turnId && this.turnId !== id) return;
        this.turnId = undefined;
        if (this.selected) this.selected.status = 'idle';
        this.status.textContent = t('harness.completed');
    }
    private renderRequests(page: HarnessEvents) {
        const requests = page.requests.filter(r => r.params?.threadId === this.selected?.id);
        const key = JSON.stringify(requests);
        if (key === this.interactionKey) return;
        this.interactionKey = key;
        this.interactions.replaceChildren(...requests.map(r => renderInteraction(r,async response => {
            if (r.id === undefined) return;
            await this.client.respond(this.profile.value,r.id,response,this.options());
        })));
    }
    private append(text: string) { this.output.textContent = ((this.output.textContent ?? '') + text).slice(-2 * 1024 * 1024); }
    private updateControls() {
        this.send.disabled = !this.selected?.resumable || !!this.turnId || this.selected.status === 'active' || !!this.pending || this.submitting;
        this.interrupt.disabled = !this.turnId || !this.owned;
        this.profile.disabled = !!this.turnId || !!this.pending || this.submitting;
    }
    private async reconcile() {
        if (!this.pending) return;
        const receipt = await this.client.operation(this.pending.profileId,this.pending.requestId,this.options());
        if (receipt.outcome === 'unknown') { this.status.textContent = t('harness.unknown'); return; }
        const result = receipt.result as { session?: HarnessSession; turnId?: string } | undefined;
        const sessionId = this.pending.sessionId;
        this.pending = undefined; this.status.textContent = t('harness.reconciled');
        if (receipt.outcome === 'committed') {
            if (result?.session) await this.select(result.session,true);
            else if (sessionId && this.selected?.id === sessionId) {
                const history = await this.client.read(this.profile.value,sessionId,this.options());
                await this.select(history.session,history.session.owned ?? this.owned);
                if (result?.turnId && !this.completedTurns.has(result.turnId)) this.turnId = result.turnId;
            }
        }
        this.updateControls(); await this.loadSessions();
    }
    private async run(action: () => Promise<void>) {
        try { await action(); } catch (error) {
            if (this.lifetime.signal.aborted) return;
            const e = error as { outcome?: string; requestId?: string };
            if (e.outcome === 'unknown' && e.requestId) this.pending = { profileId:this.profile.value,requestId:e.requestId,sessionId:this.selected?.id };
            this.status.textContent = this.pending ? `${t('harness.unknown')} ${this.pending.requestId}` : t('harness.failed');
            this.updateControls();
        }
    }
    private button(parent: HTMLElement, label: string, run: () => Promise<void>): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.onclick = async () => { button.disabled = true; try { await this.run(run); } finally { button.disabled = false; } };
        parent.append(button); return button;
    }
}

function option(value: string, label: string) { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; }
function pause(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort',done); resolve(); };
        const timer = setTimeout(done,500); signal.addEventListener('abort',done,{ once:true });
    });
}

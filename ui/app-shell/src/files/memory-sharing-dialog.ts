import { t } from '@itookit/common';
import type { MemorySharingControls } from '@itookit/llm-session/contracts';

export function showMemorySharingDialog(controls: MemorySharingControls, agentId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => new SharingDialog(controls, agentId, signal, resolve).open());
}

class SharingDialog {
    private readonly dialog = document.createElement('dialog');
    private readonly resources = document.createElement('select');
    private readonly identity = document.createElement('input');
    private readonly target = document.createElement('input');
    private readonly details = document.createElement('pre');
    private readonly status = document.createElement('p');
    private state?: Awaited<ReturnType<MemorySharingControls['state']>>;
    private busy = false;

    constructor(private readonly controls: MemorySharingControls, private readonly agentId: string,
        private readonly signal: AbortSignal | undefined, private readonly done: () => void) {}

    open(): void {
        this.dialog.className = 'session-memory-dialog';
        const title = document.createElement('h2'); title.textContent = t('memory.sharing.title'); this.dialog.append(title);
        this.field('memory.sharing.resource', this.resources); this.field('memory.sharing.newId', this.identity);
        this.field('memory.sharing.target', this.target);
        this.button('memory.sharing.create', async () => {
            const ref = await this.controls.create(this.agentId, this.identity.value);
            await this.controls.use(this.agentId, ref); await this.refresh();
        });
        this.button('memory.sharing.use', async () => {
            const resource = this.state?.resources.find(item => item.incarnation === this.resources.value);
            if (!resource) throw new Error(t('memory.sharing.choose'));
            await this.controls.use(this.agentId, resource); await this.refresh();
        });
        this.button('memory.sharing.local', async () => { await this.controls.use(this.agentId, null); await this.refresh(); });
        this.button('memory.sharing.read', async () => { await this.controls.grant(this.agentId, this.target.value, false); await this.refresh(); });
        this.button('memory.sharing.write', async () => { await this.controls.grant(this.agentId, this.target.value, true); await this.refresh(); });
        this.button('memory.sharing.revoke', async () => { await this.controls.revoke(this.agentId, this.target.value); await this.refresh(); });
        this.button('memory.sharing.delete', async () => { await this.controls.remove(this.agentId); await this.controls.use(this.agentId, null); await this.refresh(); });
        this.button('memory.sharing.audit', () => this.audit());
        this.button('memory.manage.close', async () => this.close());
        this.status.setAttribute('role', 'status'); this.dialog.append(this.details, this.status);
        this.dialog.oncancel = event => { event.preventDefault(); if (!this.busy) this.close(); };
        this.signal?.addEventListener('abort', this.close, { once: true });
        document.body.append(this.dialog); this.dialog.showModal(); this.run(() => this.refresh());
    }

    private async refresh(): Promise<void> {
        this.state = await this.controls.state(this.agentId);
        this.target.value ||= this.state.sessionId;
        this.resources.replaceChildren();
        for (const resource of this.state.resources) {
            const option = document.createElement('option'); option.value = resource.incarnation; option.textContent = resource.id;
            option.selected = resource.incarnation === this.state.policy.sharedMemory?.incarnation; this.resources.append(option);
        }
        const selected = this.state.resources.find(item => item.incarnation === this.state!.policy.sharedMemory?.incarnation);
        this.details.textContent = selected ? `${t('memory.sharing.current')}: ${selected.id}\n`
            + Object.entries(selected.grants).map(([id, grant]) => `${id}: ${t('memory.sharing.readScopes')} ${grant.readScopes.join(', ')}; ${t('memory.sharing.writeScopes')} ${grant.writeScopes.join(', ')}`).join('\n')
            : t('memory.sharing.localActive');
    }

    private async audit(): Promise<void> {
        const events = await this.controls.audit(this.agentId);
        this.details.textContent = events.map(event => `${new Date(event.at).toISOString()} ${event.action} — ${event.sessionId}`
            + (event.scope ? ` / ${event.scope}` : '') + (event.origin?.taskId ? ` / ${event.origin.taskId}` : '')).join('\n');
    }

    private field(key: Parameters<typeof t>[0], input: HTMLElement): void {
        const label = document.createElement('label'); label.textContent = t(key); input.setAttribute('aria-label', t(key));
        label.append(input); this.dialog.append(label);
    }

    private button(key: Parameters<typeof t>[0], action: () => Promise<void>): void {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = t(key);
        button.onclick = () => this.run(action); this.dialog.append(button);
    }

    private run(action: () => Promise<void>): void {
        if (this.busy) return;
        this.busy = true; this.disable(true); this.status.textContent = '';
        void action().catch(error => { this.status.textContent = error instanceof Error ? error.message : String(error); })
            .finally(() => { this.busy = false; this.disable(false); });
    }

    private disable(value: boolean): void {
        this.dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')
            .forEach(input => { input.disabled = value; });
    }

    private readonly close = (): void => { this.signal?.removeEventListener('abort', this.close); this.dialog.remove(); this.done(); };
}

import type { DirectoryMountPort, SessionFilesPort, SessionMountRecord } from '@itookit/app-contracts/services';
import { t } from '@itookit/common';
import { localizeMountError } from './localize-mount-error';

type Mode = 'mount' | 'home' | 'workspace';

/** Host-only configuration shared by sidebar, slash commands and the chat menu. */
export async function showMountDialog(service: DirectoryMountPort, files: SessionFilesPort, sessionId: string,
    mode: Mode = 'mount', signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const fixed = mode !== 'home' && (await service.fixedWorkspace(sessionId)) !== undefined;
    if (signal?.aborted) return false;
    return new Promise(resolve => new MountDialog(service, files, sessionId, mode, signal, resolve, fixed).open());
}

class MountDialog {
    private readonly dialog = document.createElement('dialog');
    private readonly path = document.createElement('input');
    private readonly at = document.createElement('input');
    private readonly access = document.createElement('select');
    private readonly cwd = document.createElement('input');
    private readonly status = document.createElement('p');
    private readonly hint = document.createElement('p');
    private readonly current = document.createElement('p');
    private readonly chooser = document.createElement('div');
    private readonly list = document.createElement('div');
    private busy = false;
    private changed = false;
    private closed = false;
    private readonly abort = () => this.close(true);

    constructor(private readonly service: DirectoryMountPort, private readonly files: SessionFilesPort,
        private readonly sessionId: string, private readonly mode: Mode, private readonly signal: AbortSignal | undefined,
        private readonly resolve: (changed: boolean) => void, private readonly fixed: boolean) {}

    open(): void {
        this.dialog.className = 'session-mount-dialog';
        const title = document.createElement('h2'); title.textContent = t(this.fixed && this.mode === 'workspace' ? 'mount.dialog.projectWorkspace' : `mount.dialog.${this.mode}`);
        const description = document.createElement('p'); description.textContent = t(this.fixed ? 'mount.dialog.fixedWorkspace' : 'mount.dialog.explanation');
        this.status.setAttribute('role', 'status');
        this.dialog.setAttribute('aria-label', title.textContent);
        this.dialog.append(title, description, this.current, this.hint);
        this.renderFields(); this.renderActions();
        this.dialog.append(this.status, this.chooser, this.list);
        this.dialog.oncancel = event => { event.preventDefault(); this.close(); };
        this.signal?.addEventListener('abort', this.abort, { once: true });
        document.body.append(this.dialog); this.dialog.showModal();
        void this.run(() => this.refresh());
    }

    private renderFields(): void {
        if (this.fixed && this.mode === 'workspace') return;
        this.path.placeholder = '/home/admin/projects/demo';
        this.field('mount.dialog.source', this.path);
        for (const value of ['rw', 'ro'] as const) {
            const option = document.createElement('option'); option.value = value; option.textContent = t(`mount.access.${value}`); this.access.append(option);
        }
        this.access.value = this.mode === 'mount' ? 'ro' : 'rw';
        if (this.mode === 'home') return;
        this.field('mount.dialog.access', this.access);
        if (this.mode === 'workspace') {
            const note = document.createElement('p'); note.textContent = t('mount.dialog.replace'); this.dialog.append(note); return;
        }
        this.at.placeholder = '/reference'; this.field('mount.dialog.target', this.at);
        if (!this.fixed) { this.cwd.type = 'checkbox'; this.field('mount.dialog.setCwd', this.cwd); }
    }

    private field(key: Parameters<typeof t>[0], input: HTMLElement): void {
        const label = document.createElement('label'); label.textContent = t(key);
        input.setAttribute('aria-label', t(key)); label.append(input); this.dialog.append(label);
    }

    private button(parent: HTMLElement, label: string, action: () => Promise<void> | void): void {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.onclick = () => { void this.run(async () => { await action(); }); }; parent.append(button);
    }

    private renderActions(): void {
        const actions = document.createElement('div');
        if (!this.fixed || this.mode !== 'workspace') this.renderMountActions(actions);
        const close = document.createElement('button'); close.type = 'button'; close.textContent = t('mount.dialog.close');
        close.onclick = () => this.close(); actions.append(close); this.dialog.append(actions);
    }

    private renderMountActions(actions: HTMLElement): void {
        this.button(actions, t('mount.dialog.internal'), () => this.browse('/home/admin'));
        if (this.service.canSelectHost) this.button(actions, t('mount.dialog.host'), async () => {
            const path = await this.service.chooseDirectory();
            // Preserve the host namespace even when its path resembles an application path.
            if (!this.closed && path) this.path.value = `host:${path}`;
            else this.status.textContent = t('mount.dialog.cancelled');
        });
        this.button(actions, t(this.mode === 'workspace' ? 'mount.dialog.save' : this.mode === 'home' ? 'mount.dialog.home' : 'mount.dialog.add'), () => this.save());
        if (this.mode === 'mount' && !this.fixed) this.button(actions, t('mount.dialog.mountDefault'), async () => {
            this.status.textContent = await this.service.mountHome(this.sessionId); this.changed = true; await this.refresh();
        });
    }

    private async save(): Promise<void> {
        const access = this.access.value as 'ro' | 'rw';
        this.status.textContent = this.mode === 'home' ? await this.service.setHome(this.path.value)
            : this.mode === 'workspace' ? await this.service.setWorkspace(this.sessionId, this.path.value, access)
                : await this.service.addDirectory(this.sessionId, this.path.value, access, this.at.value || undefined, this.cwd.checked);
        this.changed = true; await this.refresh();
    }

    private async refresh(): Promise<void> {
        const record = await this.files.inspect(this.sessionId);
        if (this.closed) return;
        this.current.textContent = t('mount.dialog.cwd', { path: record?.cwd ?? '/' });
        this.hint.textContent = this.fixed ? '' : t('mount.dialog.default', { path: this.service.getHome() ?? t('mount.dialog.unset') });
        this.list.replaceChildren();
        if (this.mode === 'home') return;
        if (!record?.mounts.length) { this.list.textContent = t('mount.dialog.empty'); return; }
        const table = document.createElement('table'); table.className = 'session-mount-dialog__table';
        const header = table.createTHead().insertRow();
        for (const key of ['source', 'target', 'access', 'actions'] as const) {
            const th = document.createElement('th'); th.textContent = t(`mount.dialog.${key}`); header.append(th);
        }
        const body = table.createTBody();
        for (const mount of record.mounts) {
            if (this.fixed && this.mode === 'workspace' && mount.at !== '/workspace') continue;
            this.renderMount(body.insertRow(), mount, record.cwd);
        }
        this.list.append(table);
    }

    private renderMount(row: HTMLTableRowElement, mount: SessionMountRecord, cwd: string): void {
        const source = row.insertCell();
        void Promise.resolve(this.service.describe(mount)).then(label => { if (!this.closed) source.textContent = label; }).catch(error => { source.textContent = String(error); });
        row.insertCell().textContent = mount.at;
        row.insertCell().textContent = t(`mount.access.${mount.access}`);
        const actions = row.insertCell();
        if (this.fixed && mount.at === '/workspace') {
            this.button(actions, t('mount.dialog.reconnect'), () => this.mutate(() => this.service.reconnect(this.sessionId, mount.mountId)));
            return;
        }
        this.button(actions, t(mount.access === 'ro' ? 'mount.dialog.makeRw' : 'mount.dialog.makeRo'),
            () => this.mutate(() => this.service.update(this.sessionId, mount.mountId, mount.access === 'ro' ? 'rw' : 'ro', false)));
        if (!this.fixed && cwd !== mount.at) this.button(actions, t('mount.dialog.setCwd'),
            () => this.mutate(() => this.service.update(this.sessionId, mount.mountId, mount.access, true)));
        this.button(actions, t('mount.dialog.reconnect'), () => this.mutate(() => this.service.reconnect(this.sessionId, mount.mountId)));
        this.button(actions, t('mount.dialog.remove'), () => this.mutate(() => this.service.remove(this.sessionId, mount.mountId)));
    }

    private async mutate(action: () => Promise<void>): Promise<void> {
        await action(); this.changed = true; await this.refresh();
    }

    private async browse(directory: string): Promise<void> {
        const children = await this.service.listDirectories(directory);
        if (this.closed) return;
        this.chooser.replaceChildren();
        this.button(this.chooser, t('mount.dialog.choose', { path: directory }), () => { this.path.value = directory; this.chooser.replaceChildren(); });
        if (directory !== '/home/admin') this.button(this.chooser, t('mount.dialog.parent'), () => this.browse(directory.slice(0, directory.lastIndexOf('/'))));
        for (const child of children) this.button(this.chooser, child.split('/').pop()!, () => this.browse(child));
    }

    private async run(action: () => Promise<void>): Promise<void> {
        if (this.busy || this.closed) return;
        this.busy = true; this.setDisabled(true);
        try { await action(); }
        catch (error) { const localized = localizeMountError(error); this.status.textContent = localized instanceof Error ? localized.message : String(localized); }
        finally { this.busy = false; this.setDisabled(false); }
    }

    private setDisabled(disabled: boolean): void {
        this.dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(input => { input.disabled = disabled; });
    }

    private close(force = false): void {
        if (this.closed || this.busy && !force) return;
        this.closed = true; this.signal?.removeEventListener('abort', this.abort);
        this.dialog.remove(); this.resolve(this.changed);
    }
}

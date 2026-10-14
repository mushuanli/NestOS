import { t } from '@itookit/common';
import type { ProjectSyncService } from '@itookit/app-contracts/services';
import type { SyncState } from '@itookit/vfs-sync';
import type { MenuItem } from '@itookit/vfs-ui';
import { SyncDialog, paragraph } from './dialog';
import { showSyncPreview, syncPreview } from './preview';
import { projectSyncIndicator, type SyncConnectionStatus } from './presentation';

export interface ProjectSyncUIOptions {
    service?: ProjectSyncService;
    setup?(projectId: string, signal: AbortSignal): Promise<void>;
    directory?(projectId: string, signal: AbortSignal): Promise<void>;
    connection?(connectionId: string): SyncConnectionStatus;
}
/** UI owns presentation; all synchronization commands go through the application service. */
export class ProjectSyncMenu {
    private readonly reads = new Map<string, number>();
    private readonly states = new Map<string, SyncState | null>();
    private readonly conflicts = new Map<string, number>();
    private readonly busy = new Set<string>();
    private readonly failures = new Map<string, string>();
    constructor(private readonly options: ProjectSyncUIOptions, private readonly signal: AbortSignal,
        private readonly report: (error: unknown) => void, private readonly changed: () => Promise<void>,
        private readonly statusChanged: () => void = () => {}) {}
    indicator(id: string) {
        const state = this.states.get(id), connectionId = state?.binding.connectionId;
        return projectSyncIndicator(state, {connection: connectionId ? this.options.connection?.(connectionId) : undefined,
            readError: this.failures.get(id), conflicts: this.conflicts.get(id)});
    }
    async refresh(id: string): Promise<void> {
        if (!this.options.service) { this.states.set(id, null); return; }
        const previous = JSON.stringify(this.indicator(id));
        const revision = (this.reads.get(id) ?? 0) + 1; this.reads.set(id, revision);
        try {
            const state = await this.options.service.status(id);
            if (this.reads.get(id) !== revision || this.signal.aborted) return;
            if (this.states.get(id)?.binding.bindingId !== state.binding.bindingId) this.conflicts.delete(id);
            this.states.set(id, state); this.failures.delete(id);
        } catch (error) {
            if (this.reads.get(id) !== revision || this.signal.aborted) return;
            if (['BINDING_NOT_FOUND', 'SYNC_CONTROL_MISSING'].includes((error as { code?: string }).code ?? '')) {
                this.states.set(id, null); this.failures.delete(id);
            } else { this.states.delete(id); this.failures.set(id, error instanceof Error ? error.message : String(error)); throw error; }
        } finally {
            if (this.reads.get(id) === revision && !this.signal.aborted && JSON.stringify(this.indicator(id)) !== previous) this.statusChanged();
        }
    }
    openStatus(id: string): Promise<void> { return this.run(id, () => this.status(id)); }
    items(id: string): MenuItem[] {
        const state = this.states.get(id), active = state?.binding.state === 'active' && !state.setupPending;
        const unavailable = this.indicator(id)?.state === 'error';
        const blocked = this.busy.has(id) || !!state?.pending || !!state?.activePlanId || unavailable;
        const action = (key: 'setup' | 'status' | 'now' | 'recover' | 'settings' | 'unbind' | 'conflicts' | 'reconcile' | 'directory', run: () => Promise<void>, disabled = false): MenuItem => ({
            id: 'project-sync-' + key, label: t(`project.sync.${key}`), disabled,
            onClick: () => { void this.run(id, run).catch(this.report); },
        });
        if (state === undefined && this.options.service) return [action('status', () => this.status(id))];
        if (!active) return [action('setup', () => this.setup(id)), action('status', () => this.status(id)),
            ...(state?.binding.state === 'detached' && state.pending ? [action('recover', () => this.recover(id), this.busy.has(id) || unavailable)] : []),
            ...(state?.setupPending ? [action('unbind', () => this.unbind(id), this.busy.has(id))] : [])];
        return [action('now', () => this.preview(id), blocked),
            ...(this.options.directory ? [action('directory', () => this.directory(id), blocked)] : []),
            ...(this.conflicts.get(id) ? [action('conflicts', () => this.preview(id), blocked)] : []), action('status', () => this.status(id)),
            ...(state.pending?.terminalExpired ? [action('reconcile', () => this.reconcile(id), this.busy.has(id))]
                : state.pending || state.activePlanId ? [action('recover', () => this.recover(id), this.busy.has(id))] : []),
            action('settings', () => this.settings(id), blocked), action('unbind', () => this.unbind(id), this.busy.has(id))];
    }
    private async run(id: string, action: () => Promise<void>): Promise<void> {
        if (this.signal.aborted || this.busy.has(id)) return;
        this.busy.add(id);
        try { await action(); } finally { this.busy.delete(id); }
    }
    private async setup(id: string): Promise<void> {
        if (!this.options.setup) {
            const dialog = new SyncDialog(t('project.sync.setup'), this.signal);
            paragraph(dialog.body, t(this.options.service ? 'project.sync.setupUnavailable' : 'project.sync.serviceUnavailable'));
            dialog.open(); return;
        }
        await this.options.setup(id, this.signal); await this.refresh(id); await this.changed();
    }
    private async directory(id: string): Promise<void> {
        await this.options.directory!(id,this.signal);await this.refresh(id);await this.changed();
    }
    private async preview(id: string): Promise<void> {
        const preview = syncPreview(await this.options.service!.preview(id));
        this.conflicts.set(id, preview.plan.conflicts.length);
        if (!this.signal.aborted) showSyncPreview(this.options.service!, id, preview, this.signal, async remaining => { this.conflicts.set(id, remaining); await this.refresh(id); await this.changed(); }, this.states.get(id)?.binding.direction);
    }
    private async status(id: string): Promise<void> {
        const dialog = new SyncDialog(t('project.sync.status'), this.signal);
        dialog.open();
        if (!this.options.service) { paragraph(dialog.body, t('project.sync.serviceUnavailable')); return; }
        dialog.message(t('project.sync.working'));
        try { await this.refresh(id); }
        catch (error) { if (!this.signal.aborted) dialog.message(t('project.sync.statusFailed', { error: error instanceof Error ? error.message : String(error) })); return; }
        if (this.signal.aborted) return;
        dialog.message('');
        const state = this.states.get(id);
        if (!state) paragraph(dialog.body, t('project.sync.unbound'));
        else {
            paragraph(dialog.body, this.indicator(id)?.label ?? t('project.sync.unbound'));
            paragraph(dialog.body, t('project.sync.mapping', { local: state.binding.root, remote: state.binding.projectId }));
            paragraph(dialog.body, t('project.sync.direction') + ': ' + t(`project.sync.${state.binding.direction}`));
            for (const issue of this.indicator(id)?.issues ?? []) paragraph(dialog.body, issue);
        }
    }
    private async recover(id: string): Promise<void> {
        await this.options.service!.recover(id); await this.refresh(id); await this.status(id); await this.changed();
    }
    private async reconcile(id: string): Promise<void> {
        const dialog = new SyncDialog(t('project.sync.reconcile'), this.signal);
        paragraph(dialog.body, t('project.sync.expiredHint'));
        dialog.button(t('project.sync.reconcileConfirm'), async () => {
            await this.options.service!.reconcileExpired(id); await this.refresh(id); await this.changed(); dialog.close();
        }); dialog.open();
    }
    private async settings(id: string): Promise<void> {
        await this.refresh(id); const state = this.states.get(id); if (!state || this.signal.aborted) return;
        const dialog = new SyncDialog(t('project.sync.settings'), this.signal), select = document.createElement('select');
        select.setAttribute('aria-label', t('project.sync.direction'));
        for (const value of ['both', 'upload', 'download'] as const) {
            const option = document.createElement('option'); option.value = value; option.textContent = t(`project.sync.${value}`); select.append(option);
        }
        select.value = state.binding.direction; dialog.body.append(select);
        paragraph(dialog.body, t('project.sync.scopeHint'));
        dialog.button(t('project.sync.save'), async () => {
            await this.options.service!.configure(id, this.options.service!.bindingToken(state.binding), { direction: select.value as 'both' | 'upload' | 'download' });
            await this.refresh(id); await this.changed(); dialog.close();
        }); dialog.open();
    }
    private async unbind(id: string): Promise<void> {
        const dialog = new SyncDialog(t('project.sync.unbind'), this.signal);
        paragraph(dialog.body, t('project.sync.unbindHint'));
        dialog.button(t('project.sync.unbindConfirm'), async () => {
            try { await this.options.service!.unbind(id); }
            finally { await this.refresh(id); await this.changed(); }
            dialog.close();
        }); dialog.open();
    }
}

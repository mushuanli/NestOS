import type { DeleteResult } from '@itookit/vfs-ui';
import { t, escapeHTML, randomUUID } from '@itookit/common';
import { Modal, Toast, type EditorTarget } from '@itookit/ui-common';
import type { ProviderDeletionImpact, MCPDeletionImpact, ProjectService } from '@itookit/app-contracts/services';
import type { ModelConfigurationCommands } from '@itookit/app-contracts/services';

/** Confirmation UI consumes domain plans; it never creates an editor to delete. */
export class ConfigurationDeletionDialog {
    constructor(private readonly commands: ModelConfigurationCommands, private readonly changed: () => Promise<void> = async () => {},
        private readonly additionalImpact: (targets: readonly EditorTarget[]) => Promise<string> = async () => '',
        private readonly projects?: Pick<ProjectService,'list'>) {}
    async request(targets: readonly EditorTarget[]): Promise<void> {
        await this.requestResult(targets);
    }
    async requestResult(targets: readonly EditorTarget[], signal?: AbortSignal): Promise<DeleteResult> {
        if (signal?.aborted) return 'cancelled';
        if (!targets.length) return 'completed';
        const kind = targets[0].kind === 'entity' ? targets[0].entityType : undefined;
        if (!kind || !['provider', 'connection', 'mcp', 'system-prompt'].includes(kind) || targets.some(target => target.kind !== 'entity' || target.entityType !== kind))
            throw new Error('Unsupported configuration deletion');
        const ids = targets.map(target => (target as Extract<EditorTarget, { kind: 'entity' }>).id);
        const preview = kind === 'provider' ? this.commands.inspectProviderDeletion(ids) : Promise.resolve(undefined);
        const [warning, providerImpact] = await Promise.all([this.additionalImpact(targets), preview]).catch(async error => {
            const impact = await preview.catch(() => undefined);
            if (impact) this.commands.discardPlan(impact.revision);
            throw error;
        });
        if (signal?.aborted) { if (providerImpact) this.commands.discardPlan(providerImpact.revision); return 'cancelled'; }
        if (providerImpact) return this.showDeleteImpactModal(providerImpact, warning, signal);
        if (kind === 'mcp') return this.showMCPImpact(await this.commands.inspectMCPDeletion(ids),warning,signal);
        return new Promise<DeleteResult>(resolve => new Modal(t('dialog.delete.title'), t('configuration.deleteConfirm', { count: ids.length }) + (warning ? ' ' + escapeHTML(warning) : '') + (kind === 'connection' ? ' ' + t('connection.deleteImpact') : kind === 'system-prompt' ? ' ' + t('prompt.deleteImpact') : ''), {
            onCancel: () => resolve('cancelled'),
            onConfirm: async () => {
                if (signal?.aborted) { resolve('cancelled'); return; }
                await this.commands.deleteResources({ kind: kind === 'system-prompt' ? 'prompts' : kind === 'connection' ? 'connections' : 'mcp', ids });
                await this.changed(); resolve('completed');
            },
        }).show());
    }
    private async showMCPImpact(impact: MCPDeletionImpact, warning: string, signal?: AbortSignal): Promise<DeleteResult> {
        const projects = await this.projects?.list() ?? [], checkbox = `mcp-delete-${randomUUID()}`;
        if (signal?.aborted) { this.commands.discardPlan(impact.revision); return 'cancelled'; }
        const rows = impact.references.map(ref => {
            const project = projects.find(item => item.project.id === ref.projectId);
            const action = impact.projects.some(item => item.id === ref.projectId) ? t('remote.mcpDeleteProjectAction') : t('remote.mcpUnlinkAction');
            const server = impact.servers.find(item => item.id === ref.connectionId)?.name || t('remote.mcpUnnamedServer');
            return `<li>${escapeHTML(project?.displayName ?? project?.name ?? t('remote.mcpMissingProject'))} — ${escapeHTML(server)} — <code>${escapeHTML(ref.at)}</code> — ${escapeHTML(action)}</li>`;
        }).join('');
        const sessions = impact.projects.flatMap(project => project.localSessions.map(session => `<li>${escapeHTML(project.name)}: ${escapeHTML(session.title)}</li>`)).join('');
        const servers = impact.ids.map(id => `<li>${escapeHTML(impact.servers.find(server => server.id === id)?.name || t('remote.mcpUnnamedServer'))}</li>`).join('');
        const body = escapeHTML(t('configuration.deleteConfirm',{count:impact.ids.length})) + `<ul>${servers}</ul>` + (warning ? ` ${escapeHTML(warning)}` : '')
            + (rows ? `<p>${escapeHTML(t('remote.mcpDeleteReferences'))}</p><ul>${rows}</ul><p>${escapeHTML(t('remote.mcpDeletePreserve'))}</p>
                ${sessions ? `<p>${escapeHTML(t('remote.mcpDeleteLocalSessions'))}</p><ul>${sessions}</ul>` : ''}
                <label><input id="${checkbox}" type="checkbox"> ${escapeHTML(t('remote.mcpForceDelete'))}</label>` : '');
        return new Promise<DeleteResult>(resolve => new Modal(t('dialog.delete.title'),body,{
            type:'danger',onCancel:() => {this.commands.discardPlan(impact.revision); resolve('cancelled');},
            onConfirm:async () => {
                if (signal?.aborted) {this.commands.discardPlan(impact.revision); resolve('cancelled'); return;}
                const force = (document.getElementById(checkbox) as HTMLInputElement | null)?.checked ?? false;
                if (impact.references.length && !force) {Toast.error(t('remote.mcpForceRequired')); return false;}
                await this.commands.deleteMCPServers({revision:impact.revision,force});
                await this.changed(); resolve('completed');
            },
        }).show());
    }
    private showDeleteImpactModal(impact: ProviderDeletionImpact, warning: string, signal?: AbortSignal): Promise<DeleteResult> {
        if (signal?.aborted) { this.commands.discardPlan(impact.revision); return Promise.resolve('cancelled'); }
        const { providers: deletable, connections: affectedConns } = impact;
        const providerListHtml = deletable.map(p =>
            `<li>${escapeHTML(p.icon ?? '')} <strong>${escapeHTML(p.name)}</strong> <code style="font-size:.75rem;opacity:.7">${escapeHTML(p.id)}</code></li>`,
        ).join('');

        const connSectionHtml = affectedConns.length > 0 ? `
            <div class="llm-delete-impact-section llm-delete-impact-section--warn">
                <div class="llm-delete-impact-section__title">
                    ⚠️ 同时将删除以下关联连接（${affectedConns.length} 个）
                </div>
                <ul class="llm-delete-impact-list">
                    ${affectedConns.map(c => `<li><strong>${escapeHTML(c.name)}</strong> <code style="font-size:.75rem;opacity:.7">${escapeHTML(c.id)}</code></li>`).join('')}
                </ul>
            </div>
        ` : '';

        const body = `
            <div style="font-size:.875rem">
                <div class="llm-delete-impact-section">
                    <div class="llm-delete-impact-section__title">将删除以下 Provider（${deletable.length} 个）</div>
                    <ul class="llm-delete-impact-list">${providerListHtml}</ul>
                </div>
                ${connSectionHtml}
                ${warning ? `<p>${escapeHTML(warning)}</p>` : ''}
                <p>${escapeHTML(t('connection.deleteImpact'))}</p>
            </div>
            <style>
                .llm-delete-impact-section { margin-bottom:14px; padding:10px 12px; border-radius:6px; background:var(--st-bg-secondary,#f8f8f8); }
                .llm-delete-impact-section--warn { background:var(--st-warning-bg,#fff8e1); }
                .llm-delete-impact-section--info { background:var(--st-info-bg,#e8f4fd); }
                .llm-delete-impact-section__title { font-weight:600; margin-bottom:6px; }
                .llm-delete-impact-list { margin:0; padding-left:18px; }
                .llm-delete-impact-list li { margin-bottom:3px; }
            </style>
        `;

        return new Promise<DeleteResult>(resolve => new Modal('确认删除 Provider', body, {
            confirmText: '确认删除', type: 'danger', width: '520px',
            onCancel: () => { this.commands.discardPlan(impact.revision); resolve('cancelled'); },
            onConfirm: async () => {
                if (signal?.aborted) { this.commands.discardPlan(impact.revision); resolve('cancelled'); return; }
                await this.commands.deleteProviders({ revision: impact.revision });
                // The backend commit determines success; navigation refresh is a separate view concern.
                void this.changed().catch(error => Toast.error(String(error))); resolve('completed');
                const parts = [`${deletable.length} 个 Provider`];
                if (affectedConns.length) parts.push(`${affectedConns.length} 个连接`);
                Toast.success(`已删除：${parts.join('、')}`);
            },
        }).show());
    }

}

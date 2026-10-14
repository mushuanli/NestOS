import { BaseSettingsEditor, editorFilePath, type EditorOptions } from '@itookit/ui-common';
import { remoteSessionPath } from '@itookit/app-contracts';
import type { ProjectService, ToolboxInventory } from '@itookit/app-contracts/services';
import { t } from '@itookit/common';
export class RemoteAgentDetailsEditor extends BaseSettingsEditor<ToolboxInventory> {
    constructor(container: HTMLElement, inventory: ToolboxInventory, options: EditorOptions, private readonly projects?: ProjectService) { super(container, inventory, options); }
    async render() {
        const path = editorFilePath(this.options) ?? '';
        const id = decodeURIComponent(path.split('/').pop()!.replace(/\.agent$/, ''));
        const agent = this.service.remoteAgents.get(id);
        const panel = document.createElement('section'); panel.className = 'toolbox-detail';
        const heading = document.createElement('h1'); heading.textContent = agent?.name ?? t('harness.remoteAgents'); panel.append(heading);
        if (!agent) { panel.append(t('toolbox.unavailable')); this.container.replaceChildren(panel); return; }
        const hint = document.createElement('p'); hint.textContent = t('harness.hint'); panel.append(hint);
        for (const project of await this.projects?.list() ?? []) {
            const mount = this.projects?.remoteMounts?.list(project.project.id).find(m => m.at === '/' && m.connectionId === agent.connectionId && m.serverProjectId);
            if (!mount) continue;
            const sessions = document.createElement('button'); sessions.type = 'button'; sessions.textContent = `${project.name} · ${t('harness.remoteSessions')}`;
            sessions.onclick = () => { void this.options.hostContext?.navigate({target: 'chat', resourceId: remoteSessionPath(project.path, agent.profile.id)}); };
            panel.append(sessions);
            if (mount.access === 'rw' && agent.profile.capabilities.create) {
                const create = document.createElement('button'); create.type = 'button'; create.textContent = `${project.name} · ${t('harness.create')}`;
                create.onclick = () => { void this.options.hostContext?.navigate({target: 'chat', resourceId: remoteSessionPath(project.path, agent.profile.id) + '/@new'}); };
                panel.append(create);
            }
        }
        this.container.replaceChildren(panel);
    }
}

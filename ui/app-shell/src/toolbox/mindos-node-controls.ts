import { mindosNodeConfiguration } from '@itookit/app-contracts';
import type { ProjectRemoteMountPort, ProjectService } from '@itookit/app-contracts/services';
import type { MCPServer } from '@itookit/tools/mcp-contracts';
import { t } from '@itookit/common';
import { showHarnessControl } from '../harness/control';

/** Presentation only; standard discovery and extension verification are owned by MCPManager. */
export class MindOSNodeMCPControls {
    private readonly lifetime = new AbortController();
    private stopMounts?: () => void;
    private mountRead = 0;
    constructor(private readonly remote: ProjectRemoteMountPort, private readonly projects?: ProjectService) {}
    render(parent: HTMLElement, server: MCPServer): void {
        const settings = mindosNodeConfiguration(server);
        if (!settings) return;
        const hint = document.createElement('p'); hint.textContent = t('remote.mcpApiKeyHint'); parent.append(hint);
        this.renderMounts(parent, server.id);
        if (settings.harness && settings.mcpEndpoint === server.endpoint) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = t('harness.open');
            button.onclick = () => { void Promise.resolve(this.remote.harness(server.id)).then(client => showHarnessControl(client,server.name,this.lifetime.signal))
                .catch(() => { hint.textContent = t('harness.failed'); }); }; parent.append(button);
        }
    }
    private renderMounts(parent: HTMLElement, connectionId: string): void {
        this.stopMounts?.(); if (!this.projects) return;
        const section = document.createElement('section'), heading = document.createElement('h4'), list = document.createElement('ul');
        heading.textContent = t('remote.currentMounts'); section.append(heading, list); parent.append(section);
        const update = async () => {
            const revision = ++this.mountRead, projects = await this.projects!.list();
            if (this.lifetime.signal.aborted || revision !== this.mountRead) return;
            const rows = projects.flatMap(project => this.remote.list(project.project.id).filter(mount => mount.connectionId === connectionId).map(mount => {
                const row = document.createElement('li'); row.textContent = `${project.name} · /${mount.alias}${mount.root === '/' ? '' : mount.root} → ${mount.at} · ${t(`remote.access.${mount.access}`)} · ${t(`remote.state.${this.remote.status(mount.mountId)}`)}`;
                return row;
            }));
            list.replaceChildren(...rows); if (!rows.length) list.textContent = t('remote.noMounts');
        };
        const refresh = () => { void update().catch(() => { if (!this.lifetime.signal.aborted) list.textContent = t('remote.mountsUnavailable'); }); };
        this.stopMounts = this.remote.onChange(refresh); refresh();
    }
    read(server: MCPServer): MCPServer {
        if (!server.apiKey || !mindosNodeConfiguration(server)) return server;
        const headers = Object.fromEntries(Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'));
        return {...server,headers,auth:undefined};
    }
    dispose(): void { this.lifetime.abort(); ++this.mountRead; this.stopMounts?.(); }
}

import { piAgentConfiguration } from '@itookit/app-contracts';
import type { ProjectRemoteMountPort } from '@itookit/app-contracts/services';
import type { MCPServer } from '@itookit/tools/mcp-contracts';
import { t } from '@itookit/common';
import { showHarnessControl } from '../harness/control';

/** Presentation only; standard discovery and extension verification are owned by MCPManager. */
export class PiAgentMCPControls {
    private readonly lifetime = new AbortController();
    constructor(private readonly remote: ProjectRemoteMountPort) {}
    render(parent: HTMLElement, server: MCPServer): void {
        const settings = piAgentConfiguration(server);
        if (!settings) return;
        const hint = document.createElement('p'); hint.textContent = t('remote.mcpApiKeyHint'); parent.append(hint);
        if (settings.harness && settings.mcpEndpoint === server.endpoint) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = t('harness.open');
            button.onclick = () => { void Promise.resolve(this.remote.harness(server.id)).then(client => showHarnessControl(client,server.name,this.lifetime.signal))
                .catch(() => { hint.textContent = t('harness.failed'); }); }; parent.append(button);
        }
    }
    read(server: MCPServer): MCPServer {
        if (!server.apiKey || !piAgentConfiguration(server)) return server;
        const headers = Object.fromEntries(Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'));
        return {...server,headers,auth:undefined};
    }
    dispose(): void { this.lifetime.abort(); }
}

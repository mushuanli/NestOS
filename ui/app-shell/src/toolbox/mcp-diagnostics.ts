import {t} from '@itookit/common';
import type {MCPServer} from '@itookit/tools/mcp-contracts';
import type {ApplicationDiagnostics, ProjectRemoteMountPort} from '@itookit/app-contracts/services';
import {showDiagnostics} from '../diagnostics/dialog';

export class MCPDiagnosticsControls {
    private readonly lifetime = new AbortController();
    constructor(private readonly diagnostics?: ApplicationDiagnostics, private readonly remote?: ProjectRemoteMountPort) {}
    render(parent: HTMLElement, server: MCPServer): void {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = t('diagnostics.connectionStatus');
        button.onclick = () => {void showDiagnostics({diagnostics: this.diagnostics, remote: this.remote, connectionId: server.id,
            title: server.name, signal: this.lifetime.signal});}; parent.append(button);
    }
    read(server: MCPServer): MCPServer {return server;}
    dispose(): void {this.lifetime.abort();}
}

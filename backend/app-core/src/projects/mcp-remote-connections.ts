import { validateAuthorization } from '@itookit/mindos-node-driver/authorization';
import type { MCPDiscovery, MCPServer } from '@itookit/tools/mcp-contracts';
import { FSError, checkOperation, type OperationOptions } from '@itookit/vfs-core';
import { remoteLog, type MCPConnectionDiagnostic, type MCPConnectionReason } from './remote-diagnostics';
import { normalizeConnection, type RemoteFileSystemConfig, type RemoteFileSystemInput } from './remote-connections';
import type { RemoteFileSourceProvider } from './remote-mounts';

const LEGACY_EXTENSION = 'itookit/fs-agent';
import { mindosNodeConfiguration, type MindOSNodeConfiguration } from '@itookit/app-contracts';
export { MINDOS_NODE_EXTENSION, mindosNodeConfiguration, isMindOSNodeTool, type MindOSNodeConfiguration } from '@itookit/app-contracts';
export interface MCPConfigurationStore {
    getMCPServers(): Promise<MCPServer[]>;
    saveMCPServer(server: MCPServer): Promise<void>;
    testMCPServer?(server: MCPServer): Promise<MCPDiscovery>;
    deleteMCPServer(id: string): Promise<void>;
}
/** A synchronous projection of the MCP catalog, never a second connection store. */
export class MCPRemoteConnections {
    private entries: RemoteFileSystemConfig[] = [];
    private refreshRevision = 0;
    private loadedRevision = 0;
    private configured: MCPConnectionDiagnostic['configured'] = [];
    constructor(private readonly store: MCPConfigurationStore, private readonly provider: RemoteFileSourceProvider) {}
    list(): RemoteFileSystemConfig[] { return structuredClone(this.entries); }
    diagnostic(id: string): MCPConnectionDiagnostic {
        const server = this.configured.find(server => server.id === id);
        return {connectionId: id, connectionName: server?.name,
            reason: server?.reason ?? (this.loadedRevision ? 'mcp-not-found' : 'catalog-not-loaded'),
            revision: this.loadedRevision, configured: structuredClone(this.configured)};
    }
    async refresh(): Promise<void> {
        const revision = ++this.refreshRevision;
        const servers = await this.store.getMCPServers();
        if (revision !== this.refreshRevision) return;
        this.loadedRevision = revision;
        this.configured = servers.map(server => ({id: server.id, name: server.name, reason: remoteMCPReason(server)}));
        const previous = this.entries;
        this.entries = servers.flatMap(server => {
            const connection = remoteMCPConnection(server);
            if (connection && server.apiKey) this.provider.setCredential(connection.credentialRef,server.apiKey);
            return connection ? [connection] : [];
        });
        for (const connection of previous) if (!this.entries.some(item => item.credentialRef === connection.credentialRef))
            this.provider.clearCredential?.(connection.credentialRef);
        remoteLog.debug('mcp.catalog.refreshed', {revision, configured: this.configured});
    }
    async ensure(id: string, options?: OperationOptions): Promise<void> {
        checkOperation(options);
        if (this.entries.some(connection => connection.id === id)) return;
        await this.refresh();
        checkOperation(options);
        if (this.entries.some(connection => connection.id === id)) return;
        const server = (await this.store.getMCPServers()).find(server => server.id === id);
        if (!server || !this.store.testMCPServer) return;
        remoteLog.debug('mcp.connection.recovery.started', this.diagnostic(id));
        const discovery = await this.store.testMCPServer({...server, ...(options?.timeoutMs ? {timeout:options.timeoutMs,timeoutUnit:'ms' as const} : {})});
        checkOperation(options);
        const verified = {...server, ...discovery};
        if (!remoteMCPConnection(verified)) return;
        await this.store.saveMCPServer(verified);
        await this.refresh();
        remoteLog.info('mcp.connection.recovery.completed', {connectionId: id, connectionName: server.name});
    }
    async migrate(connections: RemoteFileSystemConfig[], password: (id: string) => string | null): Promise<void> {
        const saved = await this.store.getMCPServers();
        for (const connection of connections) {
            const existing = saved.find(server => server.id === connection.id);
            if (existing && !sameConnection(remoteMCPConnection(existing),connection))
                throw new FSError('ECONFLICT', 'Legacy connection conflicts with an MCP configuration');
            const secret = password(connection.id);
            if (secret) this.provider.setCredential(connection.credentialRef, secret);
            if (!existing) await this.store.saveMCPServer(legacyMCPConnection(connection));
        }
        await this.refresh();
    }
    async save(input: RemoteFileSystemInput, password: string, id: string, credentialRef: string): Promise<void> {
        const value = normalizeConnection(input), saved = await this.store.getMCPServers();
        const previous = saved.find(server => server.id === id);
        if (password) this.provider.setCredential(credentialRef,password);
        let next = { ...previous, ...legacyMCPConnection({ ...value, id, credentialRef }) };
        if (previous && remoteMCPConnection(previous)?.endpoint === value.endpoint && previous.auth?.username === value.username)
            next.extensions = previous.extensions;
        else if (this.provider.discover && this.store.testMCPServer) next = {...next,...await this.store.testMCPServer(next)};
        await this.store.saveMCPServer(next);
        await this.refresh();
    }
    async remove(id: string): Promise<void> { await this.store.deleteMCPServer(id); await this.refresh(); }
}
export function remoteMCPConnection(server: MCPServer): RemoteFileSystemConfig | undefined {
    if (remoteMCPReason(server) !== 'ready') return undefined;
    const extension = mindosNodeConfiguration(server);
    const credentialRef = server.auth?.credentialRef ?? `mcp-${server.id}`;
    const basic = server.auth?.type === 'basic';
    return { ...normalizeConnection({ name: server.name, endpoint: extension!.httpEndpoint, username: basic ? server.auth?.username : undefined, anonymous: server.auth?.type === 'anonymous' }),
        authorization:validateAuthorization(extension!.authorization),
        id: server.id, credentialRef, ...(extension!.projects === true && extension!.projectProtocol === 'fs-agent-project-v1' ? {projects: true} : {}),
        ...(typeof extension!.serverId === 'string' && extension!.serverId ? {serverId: extension!.serverId} : {}) };
}
function remoteMCPReason(server: MCPServer): MCPConnectionReason {
    if (server.transport !== 'http') return 'unsupported-transport';
    const extension = mindosNodeConfiguration(server);
    if (!hasRemoteAuth(server)) return 'auth-missing';
    if (server.auth?.type === 'anonymous' && extension?.authorization?.anonymous !== true) return 'auth-missing';
    if (extension?.authorization && extension.authorization.anonymous !== (server.auth?.type === 'anonymous')) return 'auth-missing';
    if (!extension) return 'extension-missing';
    if (!validRemoteDescriptor(extension)) return 'invalid-descriptor';
    if (extension.mcpEndpoint !== server.endpoint) return 'endpoint-mismatch';
    try {
        const mcp = new URL(server.endpoint!), http = new URL(extension.httpEndpoint);
        if (mcp.origin !== http.origin || !cleanEndpoint(mcp)) return 'invalid-endpoint';
        normalizeConnection({name: server.name, endpoint: http.href, username: server.auth?.type === 'basic' ? server.auth.username : undefined});
        return 'ready';
    } catch { return 'invalid-endpoint'; }
}
function hasRemoteAuth(server: MCPServer): boolean {
    if (server.auth?.type === 'anonymous') return true;
    const credentialRef = server.auth?.credentialRef ?? (server.apiKey ? `mcp-${server.id}` : undefined);
    if (!credentialRef) return false;
    if (server.auth?.type === 'basic') return !!server.auth.username;
    return server.auth?.type === 'bearer' || !!server.apiKey;
}
function validRemoteDescriptor(extension: MindOSNodeConfiguration): boolean {
    try { validateAuthorization(extension.authorization); } catch { return false; }
    return extension.version === 1 && extension.fileProtocol === 'fs-agent-http-v1'
        && typeof extension.harness === 'boolean' && typeof extension.httpEndpoint === 'string';
}
function cleanEndpoint(endpoint: URL): boolean {
    return !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash;
}
function legacyMCPConnection(connection: RemoteFileSystemConfig): MCPServer {
    const endpoint = connection.endpoint.replace(/\/+$/, '') + '/mcp';
    return { id:connection.id,name:connection.name,transport:'http',endpoint,
        auth:{type:connection.anonymous ? 'anonymous' : connection.username ? 'basic' : 'bearer',username:connection.username,credentialRef:connection.credentialRef},
        extensions:{[LEGACY_EXTENSION]:{version:1,mcpEndpoint:endpoint,httpEndpoint:connection.endpoint,
            fileProtocol:'fs-agent-http-v1',serverId:null,harness:false,legacy:true} satisfies MindOSNodeConfiguration} };
}

function sameConnection(a: RemoteFileSystemConfig | undefined, b: RemoteFileSystemConfig): boolean {
    return !!a && ['id','name','endpoint','username','credentialRef','anonymous'].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);
}

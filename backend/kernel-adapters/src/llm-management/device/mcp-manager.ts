// @file: device-llm/device/mcp-manager.ts
//
// MCPManager — MCP server config storage and active connection lifecycle.

import { snapshotMCPConnectionOptions, type MCPConnectionOptions } from '../contracts/mcp-transport';
import { mcpConfiguration, mcpTimeoutMs, type MCPServer, type MCPDiscovery } from '@itookit/tools/mcp-contracts';
import type { IVFSManager, IFileSystem } from '@itookit/vfs-core';
import { MCPServerConnection } from '../skills/mcp-client';
import type { MCPServerConfig } from '../skills/types';
import { VFSHelpers } from './vfs-helpers';
import { MCPConfigurationExtensions, mcpConnectionIdentity } from './mcp-extensions';
import { MCPConnectionStates } from './mcp-connection-state';

const MCP_DIR = '/llm/.mcp';

export class MCPManager {
    private _mcpServers: MCPServer[] = [];
    private fingerprints = new Map<string, string>();
    private operations = new Map<string, Promise<void>>();
    private closed = false;
    private revisions = new Map<string, number>();
    private _activeMCPConns = new Map<string, MCPServerConnection>();

    constructor(
        private readonly helpers: VFSHelpers,
        private readonly vfs: IVFSManager,
        private readonly onChanged: () => void,
        options: MCPConnectionOptions = {},
    ) {
        this.options = snapshotMCPConnectionOptions(options);
        this.extensions = new MCPConfigurationExtensions(this.options.extensions);
        this.states = new MCPConnectionStates(onChanged);
    }
    private readonly options: MCPConnectionOptions;
    private readonly extensions: MCPConfigurationExtensions;
    private readonly states: MCPConnectionStates;

    // ─── Read accessors ────────────────────────────────────────────────────

    getMCPServers(): MCPServer[] {
        return this._mcpServers.map(server => {
            const connectionState = this.states.get(server.id);
            return {...server, status: connectionState.status, connectionState};
        });
    }

    getServers(): MCPServer[] {
        return this._mcpServers;
    }

    getRawServers(): MCPServer[] {
        return this._mcpServers;
    }

    getActiveConn(serverId: string): MCPServerConnection | undefined {
        return this._activeMCPConns.get(serverId);
    }

    // ─── Mutations ─────────────────────────────────────────────────────────

    saveMCPServer(server: MCPServer, systemFS?: IFileSystem): Promise<void> {
        validateMCPServer(server);
        const snapshot = structuredClone(mcpConfiguration(server));
        return this.serial(snapshot.id, () => this.saveServer(snapshot, systemFS));
    }

    private async saveServer(server: MCPServer, systemFS?: IFileSystem): Promise<void> {
        validateMCPServer(server);
        await this.extensions.prepare(server,this._mcpServers.find(item => item.id === server.id),() => this.discoverServer(server));
        await this.options.beforeSave?.(server, this._mcpServers.find(item => item.id === server.id));
        server = { ...server, timeout: mcpTimeoutMs(server), timeoutUnit: 'ms' };
        const fingerprint = this.connectionFingerprint(server);
        if (this.fingerprints.has(server.id) && this.fingerprints.get(server.id) !== fingerprint) await this.closeServer(server.id);
        await this.writeMCPToDisk(server, systemFS);
        this.revisions.set(server.id, (this.revisions.get(server.id) ?? 0) + 1);
        const idx = this._mcpServers.findIndex(s => s.id === server.id);
        if (idx >= 0) { this._mcpServers[idx] = server; } else { this._mcpServers.push(server); }
        await this.vfs.createDeviceNode('llm', `/dev/llm/mcp/${server.id}`, {
            resourceType: 'mcp',
            resourceId: server.id,
        });
        this.onChanged();
        await this.options.configurationChanged?.();
    }

    deleteMCPServer(id: string, systemFS?: IFileSystem): Promise<void> {
        validateMCPServerId(id);
        return this.serial(id, () => this.deleteServer(id, systemFS));
    }

    private async deleteServer(id: string, systemFS?: IFileSystem): Promise<void> {
        await this.options.beforeDelete?.(id);
        await this.deleteMCPFromDisk(id, systemFS);
        this.extensions.forget(id);
        this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
        this._mcpServers = this._mcpServers.filter(s => s.id !== id);
        await this.closeServer(id);
        this.states.forget(id);
        await this.vfs.removeDeviceNode(`/dev/llm/mcp/${id}`);
        this.onChanged();
        await this.options.configurationChanged?.();
    }

    // ─── Init helpers ──────────────────────────────────────────────────────

    setServers(servers: MCPServer[]): void {
        this._mcpServers = servers;
    }

    // ─── VFS reload (called from bindVFSEvents debounce) ──────────────────

    async reload(): Promise<void> {
        const revisions = new Map(this.revisions);
        const servers = await this.loadAllMCP();
        const ids = new Set([...this._mcpServers.map(server => server.id), ...servers.map(server => server.id)]);
        await Promise.all([...ids].map(id => this.serial(id, async () => {
            if ((revisions.get(id) ?? 0) !== (this.revisions.get(id) ?? 0)) return;
            const server = servers.find(item => item.id === id);
            const previous = this._mcpServers.find(item => item.id === id);
            if (!server || !previous || mcpConnectionIdentity(server) !== mcpConnectionIdentity(previous)) this.extensions.forget(id);
            const changed = !server || !previous || this.connectionFingerprint(server) !== this.connectionFingerprint(previous);
            const activeChanged = server && this.fingerprints.has(id) && this.connectionFingerprint(server) !== this.fingerprints.get(id);
            if (changed || activeChanged) await this.closeServer(id);
            if (!server) this.states.forget(id);
            this._mcpServers = this._mcpServers.filter(item => item.id !== id);
            if (server) this._mcpServers.push(server);
        })));
        await this.options.configurationChanged?.();
    }

    // ─── Connection lifecycle ──────────────────────────────────────────────

    connectMCPServer(server: MCPServer): Promise<void> {
        return this.serial(server.id, () => this.connectServer(server));
    }

    private async connectServer(server: MCPServer): Promise<void> {
        validateMCPServer(server);
        const fingerprint = this.connectionFingerprint(server);
        if (this.fingerprints.get(server.id) !== fingerprint) await this.closeServer(server.id);
        if (this._activeMCPConns.get(server.id)?.isConnected()) return;
        const connection = new MCPServerConnection(this.mcpServerToConfig(server), this.options,
            error => this.states.fail(server.id, 'connect', error));
        this.states.set(server.id, 'connecting');
        try {
            await connection.connect();
            this.fingerprints.set(server.id, fingerprint);
            this._activeMCPConns.set(server.id, connection);
            this.states.set(server.id, 'connected');
        } catch (error) { this.states.fail(server.id, 'connect', error); throw error; }
    }

    async readMCPResource(id: string, uri: string): Promise<unknown> {
        return (await this.getOrConnectServer(id, this._mcpServers)).readResource(uri);
    }

    async getMCPPrompt(id: string, name: string, args?: Record<string, string>): Promise<unknown> {
        return (await this.getOrConnectServer(id, this._mcpServers)).getPrompt(name, args);
    }

    testMCPServer(server: MCPServer): Promise<MCPDiscovery> {
        return this.serial(server.id, async () => {
            this.extensions.forget(server.id);
            try { return await this.discoverServer(structuredClone(server)); }
            catch (error) { await this.closeServer(server.id, true); throw error; }
        });
    }
    private async discoverServer(server: MCPServer): Promise<MCPDiscovery> {
        await this.connectServer(server);
        const connection = this._activeMCPConns.get(server.id)!;
        try {
            const discovered = await this.extensions.discover({server,discovery:await connection.discover(),
                callTool:(name,args) => connection.callTool(name,args)});
            this.states.set(server.id, 'connected'); return discovered;
        } catch (error) { this.states.fail(server.id, 'discover', error); throw error; }
    }
    private connectionFingerprint(server: MCPServer): string {
        const {name: _name,...config} = this.mcpServerToConfig(server);
        return JSON.stringify(config);
    }

    getOrConnectServer(serverId: string, _servers: MCPServer[]): Promise<MCPServerConnection> {
        return this.serial(serverId, async () => {
            const server = this._mcpServers.find(item => item.id === serverId);
            if (!server) throw new Error(`MCP server '${serverId}' not configured`);
            await this.connectServer(server);
            return this._activeMCPConns.get(serverId)!;
        });
    }

    disconnectServer(id: string): Promise<void> { return this.serial(id, () => this.closeServer(id)); }

    private async closeServer(id: string, retainFailure = false): Promise<void> {
        const conn = this._activeMCPConns.get(id);
        await conn?.disconnect();
        this.fingerprints.delete(id);
        this._activeMCPConns.delete(id);
        if (!retainFailure) this.states.set(id, 'idle');
    }

    async disconnectAll(): Promise<void> {
        this.closed = true;
        await Promise.allSettled(this.operations.values());
        this.extensions.clear();
        const results = await Promise.allSettled([...this._activeMCPConns.keys()].map(id => this.closeServer(id)));
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'MCP cleanup failed');
    }

    private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(new Error('MCP manager is closed'));
        const result = (this.operations.get(id) ?? Promise.resolve()).then(operation);
        const done = result.then(() => {}, () => {});
        this.operations.set(id, done);
        void done.then(() => { if (this.operations.get(id) === done) this.operations.delete(id); });
        return result;
    }

    // ─── Private helpers ───────────────────────────────────────────────────

    private async loadAllMCP(): Promise<MCPServer[]> {
        return this.helpers.loadJsonFilesFromDir<MCPServer>(MCP_DIR);
    }

    private async writeMCPToDisk(server: MCPServer, systemFS?: IFileSystem): Promise<void> {
        await this.helpers.engineUpsert(
            `${MCP_DIR}/${server.id}.json`,
            JSON.stringify(server, null, 2),
            systemFS,
        );
    }

    private async deleteMCPFromDisk(id: string, systemFS?: IFileSystem): Promise<void> {
        const fs = systemFS ?? this.helpers.getFileSystem();
        const nodeId = await fs.driver.resolvePath(`${MCP_DIR}/${id}.json`);
        if (nodeId) await fs.driver.delete([nodeId]);
    }

    /** Convert MCPServer (common) → MCPServerConfig (local transport layer) */
    mcpServerToConfig(server: MCPServer): MCPServerConfig {
        const transport = server.transport;
        return {
            name: server.name,
            auth: server.auth ? { ...server.auth } : undefined,
            transport,
            command: server.command,
            args: parseMcpArgs(server.args),
            url: server.endpoint,
            env: server.env, cwd: server.cwd, timeout: mcpTimeoutMs(server),
            headers: { ...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}), ...server.headers },
        };
    }
}

/** JSON arrays preserve spaces and quoting without executing a shell. */
export function parseMcpArgs(value?: string): string[] | undefined {
    if (!value?.trim()) return undefined;
    if (value.trim().startsWith('[')) {
        const args: unknown = JSON.parse(value);
        if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('MCP args must be a JSON string array');
        return args;
    }
    const args = value.match(/(?:[^\s"']+|"[^"\n]*"|'[^'\n]*')+/g) ?? [];
    return args.map(arg => arg.replace(/"([^"\n]*)"|'([^'\n]*)'/g, (_match, double, single) => double ?? single));
}

function validateMCPServerId(id: string): void {
    if (typeof id !== 'string' || !id.trim() || /[/\\\x00-\x1f]/.test(id)) throw new Error('Invalid MCP server ID');
}

function validateMCPServer(server: MCPServer): void {
    validateMCPServerId(server?.id);
    if (typeof server.name !== 'string' || !server.name.trim()) throw new Error('MCP server name is required');
    if (!['stdio', 'http'].includes(server.transport)) throw new Error('MCP 2026-07-28 requires stdio or Streamable HTTP; legacy transports are not supported');
    if (server.auth && (!['basic', 'bearer'].includes(server.auth.type) || typeof server.auth.credentialRef !== 'string'
        || !server.auth.credentialRef || (server.auth.type === 'basic' && (typeof server.auth.username !== 'string'
        || !server.auth.username || /[:\r\n]/.test(server.auth.username))))) throw new Error('Invalid MCP authentication');
    if (server.auth && (server.apiKey || Object.keys(server.headers ?? {}).some(key => key.toLowerCase() === 'authorization')))
        throw new Error('MCP credential references cannot be combined with inline Authorization');
    if (server.extensions && (typeof server.extensions !== 'object' || Array.isArray(server.extensions))) throw new Error('Invalid MCP extensions');
    for (const map of [server.headers, server.env]) {
        if (map !== undefined && (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some(value => typeof value !== 'string'))) throw new Error('MCP headers and environment must be string maps');
    }
}

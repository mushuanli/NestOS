import { isConnection } from './argument-validation';
// @file: kernel-adapters/llm-management/device/connection-manager.ts
//
// ConnectionManager — CRUD for LLMConnection with VFS persistence.

import type { LLMConnection, ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';
import type { IVFSManager, IFileSystem } from '@itookit/vfs-core';
import { toConnectionMeta, aggregateProviderCosts } from '@itookit/kernel-adapters/contracts';
import { snapshotLlmPresets, type LlmManagementPresets, type ProviderConnectionPolicy } from '../contracts/presets';
import { VFSHelpers } from './vfs-helpers';
import type { ProviderManager } from './provider-manager';
import { ModelDefaultStore } from './model-default-store';
import { isModelOperation, modelForOperation, type ModelDefaults, type ModelOperation } from '../contracts/model-defaults';
import type { LLMLogSink } from '@itookit/driver-llm/contracts';

const CONNECTIONS_DIR  = '/llm/.connections';
const DEFAULTS_VERSION = '/llm/.connections_version.json';

export class ConnectionManager {
    private _connections: LLMConnection[] = [];
    private defaults: ModelDefaults = {};
    private mutations: Promise<unknown> = Promise.resolve();
    private defaultOperationSequence = 0;

    constructor(
        private readonly helpers: VFSHelpers,
        private readonly vfs: IVFSManager,
        private readonly providerManager: ProviderManager,
        private readonly onChanged: () => void,
        private readonly presets: LlmManagementPresets = snapshotLlmPresets(),
        private readonly providerConnectionPolicy?: ProviderConnectionPolicy,
        private readonly credentialReadiness?: (providerId: string) => boolean | undefined,
        private readonly logger?: LLMLogSink,
    ) {}

    // ─── Public read accessors ─────────────────────────────────────────────

    getConnections(): ConnectionMeta[] {
        return this._connections.map(c => this.connToMeta(c));
    }

    getConnection(id: string): ConnectionMeta | undefined {
        const c = this.findConn(id);
        return c ? this.connToMeta(c) : undefined;
    }

    getDefaultConnection(operation: ModelOperation = 'chat'): ConnectionMeta | null {
        const id = this.defaults[operation];
        const c = id ? this.findConn(id) : undefined;
        return c ? this.connToMeta(c) : null;
    }

    loadSettings(): Promise<void> {
        return this.mutate(() => this.readModelDefaults());
    }
    private async readModelDefaults(): Promise<void> {
        const started = performance.now(), operationId = ++this.defaultOperationSequence;
        try {
            const stored = await new ModelDefaultStore(this.helpers.getFileSystem()).read();
            this.defaults = stored.defaults;
            const legacy = stored.legacy && this.getConnection(stored.legacy);
            if (legacy && modelForOperation(legacy, this.getProviderForConn(this.findConn(legacy.id)!), 'chat')) this.defaults.chat = legacy.id;
            else if (stored.legacy) this.logger?.warn('model.defaults.legacy.skipped', { operation: 'model.defaults.load', operationId, stage: 'migration', outcome: 'skipped', code: 'MODEL_DEFAULT_LEGACY_INCOMPATIBLE' });
            this.logger?.debug('model.defaults.loaded', { operation: 'model.defaults.load', operationId, stage: 'complete', outcome: 'success', count: Object.keys(this.defaults).length, durationMs: Math.round(performance.now() - started) });
        } catch (error) {
            const invalid = (error as { code?: string })?.code === 'MODEL_DEFAULT_SCHEMA_INVALID';
            const code = error instanceof SyntaxError ? 'MODEL_DEFAULT_PARSE_FAILED' : invalid ? 'MODEL_DEFAULT_SCHEMA_INVALID' : 'MODEL_DEFAULT_READ_FAILED';
            const stage = error instanceof SyntaxError ? 'parse' : invalid ? 'validation' : 'read';
            this.logger?.warn('model.defaults.load.failed', { operation: 'model.defaults.load', operationId, stage, outcome: 'failure', code, durationMs: Math.round(performance.now() - started) });
            throw error;
        }
    }

    getModelDefaults(): ModelDefaults { return { ...this.defaults }; }
    setDefaultConnection(id: string | null): Promise<void> { return this.setModelDefault('chat', id); }
    setModelDefault(operation: ModelOperation, id: string | null): Promise<void> {
        return this.mutate(() => this.writeModelDefault(operation, id));
    }
    private async writeModelDefault(operation: ModelOperation, id: string | null): Promise<void> {
        const started = performance.now(), operationId = ++this.defaultOperationSequence;
        let stage = 'validation';
        try {
            this.validateModelDefault(operation, id);
            const next = { ...this.defaults };
            if (id === null) delete next[operation]; else next[operation] = id;
            stage = 'persistence';
            await new ModelDefaultStore(this.helpers.getFileSystem()).write(next);
            this.defaults = next;
            this.onChanged();
            this.logger?.info('model.defaults.saved', { operation: 'model.defaults.set', purpose: operation, operationId, stage: 'complete', outcome: 'success', durationMs: Math.round(performance.now() - started) });
        } catch (error) {
            const code = stage === 'validation' ? (error as { code?: string }).code ?? 'MODEL_DEFAULT_INVALID' : 'MODEL_DEFAULT_SAVE_FAILED';
            this.logger?.warn('model.defaults.failed', { operation: 'model.defaults.set', purpose: isModelOperation(operation) ? operation : 'unknown', operationId, stage, code, outcome: 'failure', durationMs: Math.round(performance.now() - started) });
            throw Object.assign(error instanceof Error ? error : new Error('Model default update failed'), { code });
        }
    }

    private validateModelDefault(operation: ModelOperation, id: string | null): void {
        if (!isModelOperation(operation)) throw Object.assign(new Error('Unsupported default model operation'), { code: 'MODEL_DEFAULT_INPUT' });
        if (id === null) return;
        if (typeof id !== 'string' || !id.trim()) throw Object.assign(new Error('Invalid default connection identity'), { code: 'MODEL_DEFAULT_INPUT' });
        const raw = this.findConn(id);
        if (!raw) throw Object.assign(new Error('Default connection is missing'), { code: 'MODEL_DEFAULT_CONNECTION_MISSING' });
        const provider = this.getProviderForConn(raw);
        if (!provider) throw Object.assign(new Error('Default connection provider is missing'), { code: 'MODEL_DEFAULT_PROVIDER_MISSING' });
        if (raw.enabled === false) throw Object.assign(new Error('Default connection is disabled'), { code: 'MODEL_DEFAULT_CONNECTION_DISABLED' });
        if (provider.enabled === false) throw Object.assign(new Error('Default connection provider is disabled'), { code: 'MODEL_DEFAULT_PROVIDER_DISABLED' });
        if (!modelForOperation(this.connToMeta(raw), provider, operation)) throw Object.assign(new Error(`Connection has no configured model for ${operation}`), { code: 'MODEL_DEFAULT_CAPABILITY' });
    }

    getFullConnection(id: string): LLMConnection | null {
        return this.findConn(id) ?? null;
    }

    listConnections(): ConnectionMeta[] {
        return this._connections.map(c => this.connToMeta(c));
    }

    findConnection(id: string): ConnectionMeta | undefined {
        const c = this.findConn(id);
        return c ? this.connToMeta(c) : undefined;
    }

    /** Internal: find raw connection by id (used by openConnectionSession) */
    findRawConnection(id: string): LLMConnection | undefined {
        return this.findConn(id);
    }

    /** All raw connections (used for device node creation) */
    getRawConnections(): LLMConnection[] {
        return this._connections;
    }

    // ─── Mutations ─────────────────────────────────────────────────────────

    ensureProviderConnection(provider: LLMProvider, systemFS?: IFileSystem): Promise<void> {
        return this.mutate(() => this.ensureProviderConnectionNow(provider, systemFS));
    }

    private async ensureProviderConnectionNow(provider: LLMProvider, systemFS?: IFileSystem): Promise<void> {
        if (provider.enabled === false || this._connections.some(connection => connection.providerId === provider.id)) return;
        const connection = this.providerConnectionPolicy?.(structuredClone(provider), structuredClone(this._connections));
        if (!connection) return;
        if (connection.providerId !== provider.id || this.findConn(connection.id)) throw new Error('Invalid provider connection policy result');
        await this.saveConnectionNow(connection, systemFS);
    }

    saveConnection(conn: LLMConnection, systemFS?: IFileSystem): Promise<void> {
        const snapshot = structuredClone(conn);
        return this.mutate(() => this.saveConnectionNow(snapshot, systemFS));
    }

    private async saveConnectionNow(conn: LLMConnection, systemFS?: IFileSystem): Promise<void> {
        if (!isConnection(conn)) throw new TypeError('Invalid LLM connection');
        await this.writeToDisk(conn, systemFS);
        const idx = this._connections.findIndex(c => c.id === conn.id);
        if (idx >= 0) { this._connections[idx] = conn; } else { this._connections.push(conn); }
        await this.vfs.createDeviceNode('llm', `/dev/llm/connection/${conn.id}`, {
            resourceType: 'connection',
            resourceId: conn.id,
        });
        this.onChanged();

        // Aggregate connection costs into provider dailyCosts
        if (conn.dailyCosts && conn.providerId) {
            this.aggregateAndSaveProviderCosts(conn.providerId, systemFS).catch(() => {});
        }
    }

    deleteConnection(id: string, systemFS?: IFileSystem): Promise<void> {
        return this.mutate(() => this.deleteConnectionNow(id, systemFS));
    }

    private async deleteConnectionNow(id: string, systemFS?: IFileSystem): Promise<void> {
        const started = performance.now(), operationId = ++this.defaultOperationSequence;
        let stage = 'defaults';
        try {
            const next = Object.fromEntries(Object.entries(this.defaults).filter(([, value]) => value !== id));
            if (Object.keys(next).length !== Object.keys(this.defaults).length) {
                await new ModelDefaultStore(this.helpers.getFileSystem()).write(next);
                this.defaults = next;
                this.onChanged();
            }
            stage = 'connection'; await this.deleteFromDisk(id, systemFS);
            this._connections = this._connections.filter(c => c.id !== id);
            stage = 'device'; await this.vfs.removeDeviceNode(`/dev/llm/connection/${id}`);
            this.onChanged();
            this.logger?.info('connection.deleted', { operation: 'connection.delete', operationId, stage: 'complete', outcome: 'success', durationMs: Math.round(performance.now() - started) });
        } catch (error) {
            this.logger?.warn('connection.delete.failed', { operation: 'connection.delete', operationId, stage, outcome: 'failure', code: 'CONNECTION_DELETE_FAILED', durationMs: Math.round(performance.now() - started) });
            throw error;
        }
    }

    // ─── Init helpers ──────────────────────────────────────────────────────

    async ensureDefaultsWith(preLoaded: LLMConnection[]): Promise<LLMConnection[]> {
        if (!this.presets.connections.length) return preLoaded;
        try {
            const ver = await this.helpers.readJson<{ version: number }>(DEFAULTS_VERSION);
            if (ver && ver.version >= this.presets.version) return preLoaded;
            const updated = await this.syncDefaultConnectionsFrom(preLoaded);
            await this.helpers.writeJson(DEFAULTS_VERSION, { version: this.presets.version, updatedAt: Date.now() });
            return updated;
        } catch (e) {
            console.error('[ConnectionManager] ensureDefaults failed', e);
            return preLoaded;
        }
    }

    setConnections(connections: LLMConnection[]): void {
        this._connections = connections.filter(isConnection);
    }

    // ─── VFS reload (called from bindVFSEvents debounce) ──────────────────

    reload(): Promise<void> {
        return this.mutate(async () => {
            this._connections = await this.loadAll();
            await this.readModelDefaults();
        });
    }

    private mutate<T>(work: () => Promise<T>): Promise<T> {
        const next = this.mutations.catch(() => {}).then(work);
        this.mutations = next;
        return next;
    }

    // ─── Private helpers ───────────────────────────────────────────────────

    private async syncDefaultConnectionsFrom(current: LLMConnection[]): Promise<LLMConnection[]> {
        const byId = new Map(current.map(c => [c.id, c]));
        const result = [...current];

        for (const def of this.presets.connections) {
            const existing = byId.get(def.id);
            if (!existing) {
                const newConn: LLMConnection = {
                    id: def.id,
                    name: def.name,
                    providerId: def.providerId,
                    tiers: def.tiers,
                    metadata: { isSystemDefault: true },
                };
                await this.writeToDisk(newConn);
                result.push(newConn);
            } else {
                const updated: LLMConnection = JSON.parse(JSON.stringify(existing));
                let dirty = false;
                if (!updated.tiers && def.tiers) {
                    updated.tiers = def.tiers;
                    dirty = true;
                }
                if (dirty) {
                    await this.writeToDisk(updated);
                    const idx = result.findIndex(c => c.id === def.id);
                    if (idx >= 0) result[idx] = updated;
                }
            }
        }
        return result;
    }

    private async loadAll(systemFS?: IFileSystem): Promise<LLMConnection[]> {
        const raw = await this.helpers.loadJsonFilesFromDir<LLMConnection>(CONNECTIONS_DIR, systemFS, isConnection);
        return raw;
    }

    private async writeToDisk(conn: LLMConnection, systemFS?: IFileSystem): Promise<void> {
        await this.helpers.engineUpsert(
            `${CONNECTIONS_DIR}/${conn.id}.json`,
            JSON.stringify(conn, null, 2),
            systemFS,
        );
    }

    private async deleteFromDisk(id: string, systemFS?: IFileSystem): Promise<void> {
        const fs = systemFS ?? this.helpers.getFileSystem();
        const nodeId = await fs.driver.resolvePath(`${CONNECTIONS_DIR}/${id}.json`);
        if (nodeId) await fs.driver.delete([nodeId]);
    }

    private findConn(id: string): LLMConnection | undefined {
        return this._connections.find(c => c.id === id);
    }

    private connToMeta(conn: LLMConnection): ConnectionMeta {
        const provider = this.getProviderForConn(conn);
        const meta = toConnectionMeta(conn, provider, this.providerManager.getFullProviderMap().values());
        return { ...meta, credentialsReady: this.credentialReadiness?.(conn.providerId) ?? (meta.hasApiKey || provider?.credentialMode === 'host' || conn.providerId === 'codex') };
    }

    private getProviderForConn(conn: LLMConnection) {
        const pid = conn.providerId;
        return this.providerManager.getFullProviderMap().get(pid);
    }

    /** Aggregate all connection dailyCosts for a provider and persist */
    private async aggregateAndSaveProviderCosts(providerId: string, systemFS?: IFileSystem): Promise<void> {
        const provider = this.providerManager.getFullProviderMap().get(providerId);
        if (!provider) return;
        const pid = providerId;
        const sameProviderConns = this._connections.filter(
            c => c.providerId === pid
        );
        provider.dailyCosts = aggregateProviderCosts(sameProviderConns);
        await this.providerManager.saveProvider(provider, systemFS);
    }
}

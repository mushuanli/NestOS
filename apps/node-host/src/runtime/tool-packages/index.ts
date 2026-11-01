import {ToolHistory} from './history';
import {activationPlan} from './activation-plan';
import {disposePackageTools} from './disposal';
import {deferredConnections} from './deferred-connections';
import {ImplementationRecords, type ImplementationRef} from './execution-records';
import {PackageExecutionSlot} from './execution-slot';
import {joinUpgradeGroup, prepareUpgradeGroup, rollbackActivations, type PreparedActivation} from './upgrade-group';
import {stageVersionSwitch} from './version-switch';
import {migratePackageSettings} from './settings-migration';
import {ToolPreferences, validateSettings} from './preferences';
import {copyToolbox, readToolbox, toolboxParameters, toolboxOptionLabels, validateToolDefaults, type ToolboxDeclaration} from './toolbox';
import {userTool} from './user-tools';
import {packageGuide, copyPackageGuide} from './guide';
import {mkdir, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createModuleLogger, randomUUID} from '@itookit/common';
import type {FlowToolDependency, ToolDependencyResolver, ToolDependencyResult, ToolDependencyState, ToolPackageInfo, ToolConnectionAccess, ToolPackageSettings} from '@itookit/app-contracts/services';
import type {Tool} from '@itookit/tools';
import type {ToolMeta} from '@itookit/tools/contracts';
import {discoverToolPackages, packageError, packageIdentity, toolPackageDirectories, type ToolPackageSource} from './manifest';
import {packageFiles, packageFingerprint, resolvePackageExecutables} from './files';
import {restoreToolPackage, stageToolPackage, type InstalledToolPackage} from './install';
import {readToolPackageRegistry, withToolPackageRegistry, writeToolPackageRegistry, syncToolPackageRegistry, type RegisteredToolPackage} from './store';
import {activatePackageEnvironment, packageSourceEnvironment} from './environment';
import {readPackageFlows} from './flows';

const log = createModuleLogger('tool-packages');
interface Registrar {registerTools(tools: Tool[]): Promise<void>; unregisterTools?(ids: string[]): Promise<void>;
    prepareToolUpdate?(tools: Tool[], expected: Tool[], published?: Tool[]): Promise<{check(): void; commit(): void; rollback(): void}>;
    toolCatalog: {getToolMeta(id: string): ToolMeta | undefined};}
export interface NodeToolPackageOptions {
    canManage?: boolean; preferencesFile?: string; connections?: ToolConnectionAccess; env?: NodeJS.ProcessEnv; directories?: string[]; dataDirectory?: string; registryFile?: string;
}

/** Executable locations come exclusively from a trusted host catalog and host environment. */
export class NodeToolPackages implements ToolDependencyResolver {
    private readonly historyStore: ToolHistory;
    private readonly preferences: ToolPreferences;
    private readonly declarations = new Map<string, ToolboxDeclaration>();
    private readonly env: NodeJS.ProcessEnv;
    private readonly registryFile: string;
    private dataDirectory: string;
    private readonly sources = new Map<string, ToolPackageSource>();
    private readonly installed = new Map<string, InstalledToolPackage>();
    private readonly failures = new Map<string, {code: string; reason: string}>();
    private readonly connectionOwners = new Map<string, Set<string>>();
    private readonly pendingVersions = new Map<string, string>();
    private readonly migrationWarnings = new Map<string, string>();
    private records: RegisteredToolPackage[] = [];
    private registrar?: Registrar;
    private readonly environments = new Map<string, () => void>();
    private tail = Promise.resolve();
    private implementations!: ImplementationRecords;
    private readonly slots = new Map<string, Map<string, PackageExecutionSlot>>();
    private readonly historical = new Map<string, Promise<InstalledToolPackage>>();
    private readonly retiring = new Map<string, Promise<void>>();
    private readonly blocked = new Set<string>();
    private leaveGroup?: () => void;
    private closed = false;
    private readonly listeners = new Set<() => void>();
    private notificationQueued = false;
    onChange(listener: () => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}
    private notify(): void {
        if (this.notificationQueued || this.closed) return;
        this.notificationQueued = true;
        queueMicrotask(() => {
            this.notificationQueued = false;
            if (this.closed) return;
            for (const listener of this.listeners) try {listener();} catch {log.warn('tool.package.observer', {stage: 'notify', result: 'failure', code: 'TOOL_PACKAGE_OBSERVER_FAILED'});}
        });
    }

    constructor(private readonly options: NodeToolPackageOptions = {}) {
        this.env = packageSourceEnvironment(options.env ?? process.env);
        this.dataDirectory = path.resolve(options.dataDirectory ?? path.join(this.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), 'nestos/tools'));
        this.preferences = new ToolPreferences(options.preferencesFile ?? path.join(this.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'nestos/tool-preferences/preferences.json'));
        this.historyStore = new ToolHistory(path.join(path.dirname(options.preferencesFile ?? path.join(this.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'nestos/tool-preferences/preferences.json')), 'history.json'));
        this.registryFile = path.resolve(options.registryFile ?? path.join(this.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'nestos/tool-packages.json'));
    }

    async initialize(): Promise<void> {
        const operationId = randomUUID(), started = performance.now();
        try {
            await this.preferences.initialize(); await this.historyStore.initialize();
            await mkdir(this.dataDirectory, {recursive: true}); this.dataDirectory = await realpath(this.dataDirectory);
            this.implementations = new ImplementationRecords(this.dataDirectory);
            for (const source of await discoverToolPackages(this.options.directories ?? toolPackageDirectories(this.env))) this.addSource(source);
            this.records = await readToolPackageRegistry(this.registryFile);
            for (const record of this.records) {
                try {this.installed.set(record.id, await restoreToolPackage(this.packageDirectory(record), record, this.connectionsFor(record.id)));}
                catch (error) {
                    const failure = failureReason(error, 'restore'); this.failures.set(record.id, failure);
                    this.record(operationId, 'restore-package', 'failure', started, 0, failure.code);
                }
            }
            await this.prepareBundled();
            await this.distributeDeclarations();
            for (const installed of this.installed.values()) await this.bindUserTools(installed);
            await this.joinGroup();
            this.record(operationId, 'restore', this.failures.size ? 'partial' : 'success', started, this.installed.size);
        } catch (error) {
            const failure = failureReason(error, 'restore'); this.record(operationId, 'restore', 'failure', started, 0, failure.code);
            throw Object.assign(new Error(failure.reason), {code: failure.code});
        }
    }

    private async prepareBundled(): Promise<void> {
        for (const source of this.sources.values()) {
            const started = performance.now(), operationId = randomUUID();
            try {
                const declaration = await readToolbox(source);
                if (declaration) this.declarations.set(packageKey(source), declaration);
                if (!declaration?.preinstall || this.installed.has(source.manifest.id)) continue;
                const installed = await this.preinstall(source);
                this.installed.set(source.manifest.id, installed); this.failures.delete(source.manifest.id);
            } catch (error) {
                if (this.installed.get(source.manifest.id)?.registration.version === source.manifest.version) throw error;
                const failure = failureReason(error, 'preinstall'); this.failures.set(source.manifest.id, failure);
                this.record(operationId, 'preinstall', 'failure', started, 0, failure.code);
            }
        }
    }
    private async preinstall(source: ToolPackageSource): Promise<InstalledToolPackage> {
        const started = performance.now(), operationId = randomUUID();
        const result = await withToolPackageRegistry(this.registryFile, async () => {
            const current = await readToolPackageRegistry(this.registryFile), record = current.find(item => item.id === source.manifest.id);
            if (record && record.version !== source.manifest.version) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', 'A different package version is already installed');
            const installed = record ? await restoreToolPackage(this.packageDirectory(record), record, this.connectionsFor(record.id))
                : await stageToolPackage(source, this.packageDirectory(source.manifest), this.env, this.connectionsFor(source.manifest.id));
            this.records = current.filter(item => item.id !== installed.registration.id).concat(installed.registration);
            await writeToolPackageRegistry(this.registryFile, this.records); return installed;
        });
        this.record(operationId, 'preinstall', 'success', started, result.tools.length); return result;
    }
    private async distributeDeclarations(): Promise<void> {
        for (const source of this.sources.values()) {
            const installed = this.installed.get(source.manifest.id);
            if (!installed || installed.registration.version !== source.manifest.version || installed.source.root === source.root) continue;
            await copyToolbox(source, installed.source.root); await copyPackageGuide(source, installed.source.root);
        }
    }
    private async bindUserTools(installed: InstalledToolPackage): Promise<void> {
        const key = packageKey(installed.source);
        const declaration = this.declarations.get(key) ?? await readToolbox(installed.source);
        if (!declaration) {installed.tools = installed.tools.map(tool => userTool(tool, this.preferences, key, this.historyStore, undefined, true)); return;}
        this.declarations.set(key, declaration);
        try {await migratePackageSettings(installed, declaration, this.preferences);}
        catch (error) {
            if ((error as {code?: string}).code !== 'TOOL_PACKAGE_DEFAULT_INVALID') throw error;
            this.migrationWarnings.set(key, 'TOOL_PACKAGE_DEFAULT_INVALID');
            this.record(randomUUID(), 'migrate-user-settings', 'partial', performance.now(), 0, 'TOOL_PACKAGE_DEFAULT_INVALID');
        }
        const settings = this.preferences.get(key);
        for (const tool of installed.tools) {
            const fields = declaration.tools[tool.name]?.parameters ?? [];
            toolboxParameters(tool, fields); validateToolDefaults(tool, fields.map(field => field.name), settings.defaults[tool.name] ?? {});
        }
        installed.tools = installed.tools.map(tool => userTool(tool, this.preferences, key, this.historyStore, declaration.tools[tool.name]?.enableWith));
    }
    configure(id: string, version: string, settings: ToolPackageSettings): Promise<void> {
        const work = this.tail.then(() => withToolPackageRegistry(this.registryFile, () => this.configurePackage(id, version, settings)));
        this.tail = work.catch(() => {}); return work;
    }
    private async configurePackage(id: string, version: string, settings: ToolPackageSettings): Promise<void> {
        const operationId = randomUUID(), started = performance.now(); let stage = 'configure-validate';
        try {
            packageIdentity(id, 'id'); packageIdentity(version, 'version'); validateSettings(settings);
            const installed = this.installed.get(id), declaration = this.declarations.get(`${id}@${version}`);
            if (!installed || installed.registration.version !== version || !declaration) throw packageError('TOOL_PACKAGE_CONFIGURATION_UNAVAILABLE', 'Install this package version before configuring it');
            if (settings.disabledTools?.some(id => !installed.tools.some(tool => tool.name === id))) throw packageError('TOOL_PACKAGE_DEFAULT_INVALID', 'Disabled tools must belong to this package');
            for (const [toolId, values] of Object.entries(settings.defaults)) {
                const tool = installed.tools.find(item => item.name === toolId), fields = declaration.tools[toolId]?.parameters;
                if (!tool || !fields) throw packageError('TOOL_PACKAGE_DEFAULT_INVALID', 'Defaults must name configurable package tools');
                validateToolDefaults(tool, fields.map(field => field.name), values);
            }
            stage = 'configure-persist'; await this.preferences.save(`${id}@${version}`, settings);
            this.notify();
            this.record(operationId, stage, 'success', started, Object.keys(settings.defaults).length);
        } catch (error) {
            const failure = failureReason(error, 'configuration'); this.record(operationId, stage, 'failure', started, 0, failure.code);
            throw Object.assign(new Error(failure.reason), {code: failure.code});
        }
    }
    async history(id: string, version: string) {
        packageIdentity(id, 'id'); packageIdentity(version, 'version'); return this.historyStore.list(`${id}@${version}`);
    }
    switchVersion(id: string, version: string, expectedVersion: string, operationId = randomUUID()): Promise<void> {
        const started = performance.now();
        const work = this.tail.then(async () => {
            packageIdentity(id, 'id'); packageIdentity(version, 'version'); packageIdentity(expectedVersion, 'expected version'); packageIdentity(operationId, 'operation id');
            if (this.options.canManage === false) throw packageError('TOOL_PACKAGE_SWITCH_DENIED', 'Only the host administrator can switch shared package versions');
            const receipt = (await readToolPackageRegistry(this.registryFile)).find(row => row.id === id);
            if (receipt?.activationId === operationId && receipt.version === version) {await this.reconcileRegistry(); return;}
            await this.refreshCatalog();
            const active = this.installed.get(id), source = this.sources.get(`${id}@${version}`);
            if (!active || active.registration.version !== expectedVersion || version === expectedVersion) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', 'Refresh the active package version before switching');
            if (!source || !this.registrar) throw packageError('TOOL_PACKAGE_SWITCH_UNAVAILABLE', 'The selected version is unavailable in the trusted host catalog');
            await stageVersionSwitch(source, active, this.packageDirectory(source.manifest), this.registryFile, this.env, this.registrar.toolCatalog, this.implementations, operationId);
            log.info('tool.package.version', {operationId, packageId: id, fromVersion: expectedVersion, toVersion: version, stage: 'activate-version', result: 'success', durationMs: Math.round(performance.now() - started)});
        }).catch(error => {log.warn('tool.package.version', {operationId, packageId: id, fromVersion: expectedVersion, toVersion: version, stage: 'prepare-version-switch', result: 'failure', code: failureReason(error, 'switch').code, durationMs: Math.round(performance.now() - started)}); throw error;});
        this.tail = work.catch(() => {}); return work;
    }
    uninstall(id: string, version: string): Promise<void> {
        const started = performance.now(), operationId = randomUUID();
        const work = this.tail.then(async () => {
            packageIdentity(id, 'id'); packageIdentity(version, 'version');
            const installed = this.installed.get(id), key = `${id}@${version}`;
            if (this.options.canManage === false || this.declarations.get(key)?.preinstall) throw packageError('TOOL_PACKAGE_REMOVE_DENIED', 'This package is shared or preinstalled; disable it for your user');
            if (!installed || installed.registration.version !== version || !this.registrar?.unregisterTools) throw packageError('TOOL_PACKAGE_REMOVE_UNAVAILABLE', 'Package removal is unavailable');
            const settings = {...this.preferences.get(key), enabled: this.preferences.enabled(key, undefined, !this.declarations.has(key))};
            await this.preferences.save(key, {...settings, enabled: false});
            if (this.historyStore.busy(key) || [...this.slots.get(id)?.values() ?? []].some(slot => slot.counts().length)) {await this.preferences.save(key, settings); throw packageError('TOOL_PACKAGE_BUSY', 'Wait for running tools before removing this package');}
            await withToolPackageRegistry(this.registryFile, async () => {
                const current = await readToolPackageRegistry(this.registryFile), next = current.filter(row => row.id !== id);
                if (current.find(row => row.id === id)?.version !== version) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', 'Registered version changed before uninstall');
                await writeToolPackageRegistry(this.registryFile, next);
                try {await this.registrar!.unregisterTools!(installed.tools.map(tool => tool.name));}
                catch (error) {await writeToolPackageRegistry(this.registryFile, current); throw error;}
                this.records = next; this.installed.delete(id); this.environments.get(id)?.(); this.environments.delete(id);
            });
            this.record(operationId, 'uninstall', 'success', started, installed.tools.length);
            this.notify();
        }).catch(error => {this.record(operationId, 'uninstall', 'failure', started, 0, failureReason(error, 'uninstall').code); throw error;}); this.tail = work.catch(() => {}); return work;
    }
    userTools(tools: Tool[]): Tool[] {
        return tools.map(tool => {
            const installed = [...this.installed.values()].find(item => item.tools.some(entry => entry.name === tool.name));
            return installed && this.declarations.has(packageKey(installed.source)) ? userTool(tool, this.preferences, packageKey(installed.source), this.historyStore, this.declarations.get(packageKey(installed.source))?.tools[tool.name]?.enableWith) : tool;
        });
    }
    initialTools(): Tool[] {return [...this.installed.values()].flatMap(item => item.tools.map(tool => this.slot(item, tool).tool));}
    async flowTemplates(packageId: string, version: string) {
        packageIdentity(packageId, 'id'); packageIdentity(version, 'version'); await this.tail;
        const installed = this.installed.get(packageId);
        if (!installed || installed.registration.version !== version) throw packageError('TOOL_PACKAGE_NOT_REGISTERED', 'Register this package version before installing its workflows');
        if (await packageFingerprint(installed.source, await packageFiles(installed.source, installed.registration.bindings)) !== installed.registration.fingerprint)
            throw packageError('TOOL_PACKAGE_CONTENT_CONFLICT', 'Installed package resources differ from their registration');
        return readPackageFlows(installed.source);
    }
    async bind(registrar: Registrar): Promise<void> {
        for (const installed of this.installed.values()) this.activate(installed);
        this.registrar = registrar;
        await withToolPackageRegistry(this.registryFile, async () => {
            await this.reconcileRecords(await readToolPackageRegistry(this.registryFile));
            for (const installed of this.installed.values()) {
                if (!registrar.prepareToolUpdate) continue;
                const slots = installed.tools.map(tool => this.slot(installed, tool).tool);
                try {const update = await registrar.prepareToolUpdate(installed.tools, slots, slots); update.check(); update.commit();}
                catch (error) {if ((error as {code?: string}).code !== 'TOOL_PACKAGE_TOOL_CONFLICT') throw error;}
            }
        });
    }
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true; this.leaveGroup?.(); this.leaveGroup = undefined;
        this.listeners.clear();
        await this.tail; await Promise.allSettled(this.retiring.values());
        const historical = await Promise.allSettled(this.historical.values());
        const packages = [...this.installed.values(), ...historical.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])];
        await disposePackageTools(packages.flatMap(installed => installed.tools), 'runtime-close');
        await this.historyStore.close(); for (const release of this.environments.values()) release(); this.environments.clear(); this.registrar = undefined;
        this.historical.clear(); this.slots.clear();
    }

    async list(): Promise<ToolPackageInfo[]> {
        await this.tail;
        await this.refreshCatalog(); await this.reconcileRegistry();
        const entries = new Map(this.sources);
        for (const installed of this.installed.values()) entries.set(packageKey(installed.source), installed.source);
        const result: ToolPackageInfo[] = [];
        for (const source of entries.values()) result.push(await this.packageInfo(source));
        for (const record of this.records.filter(item => ![...entries.values()].some(source => source.manifest.id === item.id && source.manifest.version === item.version))) {
            const failure = this.failures.get(record.id);
            result.push({id: record.id, version: record.version, tools: [], status: 'failed', ...failure});
        }
        return result.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
    }

    private async refreshCatalog(): Promise<void> {
        const sources = await discoverToolPackages(this.options.directories ?? toolPackageDirectories(this.env));
        const next = new Map<string, ToolPackageSource>();
        for (const source of sources) {
            const key = packageKey(source);
            if (next.has(key)) throw packageError('TOOL_PACKAGE_CATALOG_CONFLICT', 'The trusted catalog contains duplicate package versions');
            next.set(key, source);
            const declaration = await readToolbox(source); if (declaration) this.declarations.set(key, declaration);
        }
        this.sources.clear(); for (const [key, source] of next) this.sources.set(key, source);
    }
    private async joinGroup(): Promise<void> {
        await withToolPackageRegistry(this.registryFile, async () => {
            await this.reconcileRecords(await readToolPackageRegistry(this.registryFile));
            for (const installed of this.installed.values()) await this.implementations.save(installed.registration);
            this.leaveGroup = joinUpgradeGroup(this.registryFile, this);
        });
    }
    private async reconcileRegistry(): Promise<void> {
        await withToolPackageRegistry(this.registryFile, async () => {
            const records = await readToolPackageRegistry(this.registryFile);
            for (const record of records) {
                const plans = await prepareUpgradeGroup(this.registryFile, record);
                try {
                    for (const plan of plans) plan.check();
                    if (plans.some(plan => plan.needsSync)) await syncToolPackageRegistry(this.registryFile);
                    for (const plan of plans) plan.commit();
                } catch (error) {
                    for (const plan of plans) plan.block();
                    await rollbackActivations(plans); throw error;
                }
            }
            this.records = records;
        });
    }
    private async reconcileRecords(records: RegisteredToolPackage[]): Promise<void> {
        if (this.blocked.size) await syncToolPackageRegistry(this.registryFile);
        for (const record of records) {
            const active = this.installed.get(record.id);
            if (!active || active.registration.version === record.version && active.registration.fingerprint === record.fingerprint && !this.blocked.has(record.id)) continue;
            const activation = await this.preparePackage(record); activation.check(); activation.commit();
        }
        this.records = records;
    }
    private slot(installed: InstalledToolPackage, tool: Tool): PackageExecutionSlot {
        const id = installed.registration.id, slots = this.slots.get(id) ?? new Map<string, PackageExecutionSlot>();
        this.slots.set(id, slots);
        if (!slots.has(tool.name)) slots.set(tool.name, new PackageExecutionSlot(tool, () => {
            if (this.closed || this.blocked.has(id)) throw packageError('TOOL_PACKAGE_UPGRADE_INDETERMINATE', 'Tool admission is waiting for version reconciliation');
            return this.installed.get(id)?.registration ?? installed.registration;
        }, reference => this.resolveImplementation(reference), version => this.releaseHistorical(id, version), () => this.notify()));
        return slots.get(tool.name)!;
    }
    private releaseHistorical(id: string, version: string): void {
        if (this.blocked.has(id) || this.installed.get(id)?.registration.version === version) return;
        if ([...this.slots.get(id)?.values() ?? []].some(slot => slot.counts().some(row => row.version === version))) return;
        for (const [key, loading] of this.historical) if (key.startsWith(`${id}@${version}#`)) {
            this.historical.delete(key);
            const disposal = loading.then(installed => disposePackageTools(installed.tools, 'retired-instance')).catch(() => {});
            this.retiring.set(key, disposal);
            void disposal.finally(() => {if (this.retiring.get(key) === disposal) this.retiring.delete(key);});
        }
    }
    private async resolveImplementation(reference: ImplementationRef): Promise<Tool> {
        const key = `${reference.packageId}@${reference.version}#${reference.fingerprint}`;
        await this.retiring.get(key);
        const active = this.installed.get(reference.packageId);
        let installed: InstalledToolPackage;
        if (active?.registration.fingerprint === reference.fingerprint && active.registration.version === reference.version) installed = active;
        else {
            let loading = this.historical.get(key);
            if (!loading) {loading = this.restoreHistorical(reference); this.historical.set(key, loading); void loading.catch(() => this.historical.delete(key));}
            installed = await loading;
        }
        const tool = installed.tools.find(tool => tool.name === reference.toolId && (tool.version ?? '1') === reference.toolVersion);
        if (!tool) throw packageError('TOOL_PACKAGE_IMPLEMENTATION_UNAVAILABLE', 'The bound implementation no longer provides this tool');
        return tool;
    }
    private async restoreHistorical(reference: ImplementationRef): Promise<InstalledToolPackage> {
        const record = await this.implementations.read({id: reference.packageId, version: reference.version, fingerprint: reference.fingerprint});
        const connections = deferredConnections(this.connectionsFor(reference.packageId));
        const installed = await restoreToolPackage(this.packageDirectory(record), record, connections.access);
        await this.bindUserTools(installed); connections.activateHistorical(); return installed;
    }
    async preparePackage(record: RegisteredToolPackage): Promise<PreparedActivation> {
        const active = this.installed.get(record.id);
        if (!active && this.failures.has(record.id) && this.records.some(row => row.id === record.id && row.fingerprint === record.fingerprint))
            return {check: () => {}, commit: () => {}, rollback: () => {}, block: () => {}, resume: () => {}};
        if (active?.registration.version === record.version && active.registration.fingerprint === record.fingerprint) {
            const changed = this.blocked.has(record.id) || active.registration.activationId !== record.activationId;
            return {needsSync: this.blocked.has(record.id), check: () => {if (this.closed) throw packageError('TOOL_PACKAGE_RUNTIME_UNAVAILABLE', 'User runtime is closing');},
                commit: () => {active.registration = record; this.blocked.delete(record.id); if (changed) this.notify();}, rollback: () => {},
                block: () => {this.blocked.add(record.id);}, resume: () => {this.blocked.delete(record.id);}};
        }
        const key = `${record.id}@${record.version}`, hadSettings = this.preferences.has(key);
        const rollbackSettings = async () => {if (!hadSettings && this.preferences.has(key)) await this.preferences.remove(key);};
        try {return await this.prepareActivation(record, rollbackSettings);}
        catch (error) {await rollbackSettings(); throw error;}
    }
    private async prepareActivation(record: RegisteredToolPackage, rollbackSettings: () => Promise<void>): Promise<PreparedActivation> {
        await this.retiring.get(`${record.id}@${record.version}#${record.fingerprint}`);
        const previous = this.installed.get(record.id), connections = deferredConnections(this.connectionsFor(record.id));
        const next = await restoreToolPackage(this.packageDirectory(record), record, connections.access);
        await this.bindUserTools(next);
        if (this.migrationWarnings.has(packageKey(next.source))) throw packageError('TOOL_PACKAGE_DEFAULT_INVALID', 'Saved tool settings need migration before upgrading');
        const retained = this.historical.get(`${record.id}@${record.version}#${record.fingerprint}`);
        if (retained) next.tools = (await retained).tools;
        const connectionPlan = connections.prepare();
        const published = next.tools.map(tool => this.slot(next, tool).tool), expected = previous?.tools.map(tool => this.slot(previous, tool).tool) ?? [];
        if (this.registrar && !this.registrar.prepareToolUpdate) throw packageError('TOOL_PACKAGE_SWITCH_UNAVAILABLE', 'The running host does not support atomic tool activation');
        const catalog = await this.registrar?.prepareToolUpdate?.(next.tools, expected, published);
        return activationPlan({needsSync: this.blocked.has(record.id),
            check: () => {if (this.closed) throw packageError('TOOL_PACKAGE_RUNTIME_UNAVAILABLE', 'User runtime is closing');},
            connections: connectionPlan, catalog, rollbackSettings,
            publish: () => this.publishPackage(next, previous, connections.types.keys()),
            block: () => {this.blocked.add(record.id);}, resume: () => {this.blocked.delete(record.id);}});
    }
    private publishPackage(next: InstalledToolPackage, previous: InstalledToolPackage | undefined, typeIds: Iterable<string>): () => void {
        const {id} = next.registration, oldRecords = this.records, oldFailure = this.failures.get(id), oldOwners = this.connectionOwners.get(id);
        const activated = this.activate(next);
        if (previous) this.historical.set(`${id}@${previous.registration.version}#${previous.registration.fingerprint}`, Promise.resolve(previous));
        this.installed.set(id, next); for (const tool of next.tools) this.slot(next, tool).replace(tool);
        this.records = this.records.filter(row => row.id !== id).concat(next.registration);
        this.connectionOwners.set(id, new Set([...oldOwners ?? [], ...typeIds]));
        this.failures.delete(id); this.blocked.delete(id); this.pendingVersions.delete(id); this.notify();
        if (previous) queueMicrotask(() => this.releaseHistorical(id, previous.registration.version));
        return () => {
            if (activated) {this.environments.get(id)?.(); this.environments.delete(id);}
            if (previous) {this.installed.set(id, previous); for (const tool of previous.tools) this.slot(previous, tool).replace(tool);}
            else this.installed.delete(id);
            if (oldFailure) this.failures.set(id, oldFailure);
            if (oldOwners) this.connectionOwners.set(id, oldOwners); else this.connectionOwners.delete(id);
            this.records = oldRecords;
        };
    }

    async ensure(dependencies: readonly FlowToolDependency[]): Promise<ToolDependencyResult> {
        const tools: ToolDependencyState[] = [];
        for (const dependency of dependencies) {
            try {await this.ensureTool(dependency); tools.push({...dependency, status: 'ready'});}
            catch (error) {
                const failure = failureReason(error, 'install');
                tools.push({...dependency, status: failure.code === 'TOOL_PACKAGE_NOT_FOUND' || failure.code === 'TOOL_PACKAGE_EXECUTABLE_MISSING' ? 'missing' : 'failed', ...failure});
            }
        }
        return {tools};
    }

    install(reference: {id: string; version: string}, expected?: FlowToolDependency): Promise<void> {
        const work = this.tail.then(() => this.installPackage(reference, expected)); this.tail = work.catch(() => {}); return work;
    }

    private async ensureTool(dependency: FlowToolDependency): Promise<void> {
        if (!dependency || typeof dependency.id !== 'string' || !dependency.id || dependency.version !== undefined && typeof dependency.version !== 'string')
            throw packageError('TOOL_PACKAGE_DEPENDENCY_INVALID', 'Tool dependencies must contain a tool identity and optional exact version');
        const registered = this.registrar?.toolCatalog.getToolMeta(dependency.id);
        if (registered) {assertRegisteredTool(dependency, registered); return;}
        const providers = [...this.sources.values()].filter(source => source.manifest.tools.some(tool => tool.id === dependency.id));
        const available = providers.filter(source => source.manifest.tools.some(tool => tool.id === dependency.id
            && (dependency.version === undefined || tool.version === undefined || tool.version === dependency.version)));
        if (providers.length && !available.length) throw packageError('TOOL_PACKAGE_TOOL_VERSION_CONFLICT', `Trusted local packages provide a different version of ${dependency.id}; requested ${dependency.version}`);
        if (!available.length) throw packageError('TOOL_PACKAGE_NOT_FOUND', `No trusted local package provides ${dependency.id}${dependency.version ? '@' + dependency.version : ''}`);
        if (available.length > 1) throw packageError('TOOL_PACKAGE_CATALOG_CONFLICT', `Multiple trusted packages provide ${dependency.id}; select one catalog source`);
        await this.install({id: available[0].manifest.id, version: available[0].manifest.version}, dependency);
        const installed = this.registrar?.toolCatalog.getToolMeta(dependency.id);
        if (!installed) throw packageError('TOOL_PACKAGE_EXPORT_MISMATCH', `The installed package does not provide ${dependency.id}`);
        assertRegisteredTool(dependency, installed);
    }

    private async installPackage(reference: {id: string; version: string}, expected?: FlowToolDependency): Promise<void> {
        const operationId = randomUUID(), started = performance.now(); let stage = 'resolve';
        try {
            packageIdentity(reference.id, 'id'); packageIdentity(reference.version, 'version');
            const current = this.records.find(item => item.id === reference.id);
            if (current && current.version !== reference.version) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', `Package ${reference.id}@${current.version} is already registered; requested ${reference.version}`);
            const source = this.sources.get(`${reference.id}@${reference.version}`) ?? this.installed.get(reference.id)?.source;
            if (!source) throw packageError('TOOL_PACKAGE_NOT_FOUND', `Trusted local package ${reference.id}@${reference.version} is unavailable`);
            if (!this.registrar) throw packageError('TOOL_PACKAGE_RUNTIME_UNAVAILABLE', 'Tool registration runtime is not ready');
            stage = 'stage';
            const installed = current ? await this.existingPackage(source, current) : await stageToolPackage(source, this.packageDirectory(reference), this.env, this.connectionsFor(reference.id));
            if (!current || !this.installed.has(reference.id)) await this.bindUserTools(installed);
            if (expected) assertToolVersion(expected, installed.tools.find(tool => tool.name === expected.id)?.version);
            stage = 'register'; const activated = this.activate(installed);
            try {await this.commitPackage(installed);} catch (error) {
                if (activated) {this.environments.get(reference.id)?.(); this.environments.delete(reference.id);} throw error;
            }
            this.record(operationId, stage, 'success', started, installed.tools.length);
        } catch (error) {const failure = failureReason(error, stage); this.record(operationId, stage, 'failure', started, 0, failure.code); throw Object.assign(new Error(failure.reason), {code: failure.code});}
    }

    private async commitPackage(installed: InstalledToolPackage): Promise<void> {
        const additions = installed.tools.filter(tool => {
            const existing = this.registrar!.toolCatalog.getToolMeta(tool.name);
            if (!existing) return true;
            assertToolVersion({id: tool.name, version: tool.version ?? '1'}, existing.version); return false;
        }).map(tool => this.slot(installed, tool).tool);
        if (this.installed.get(installed.registration.id) === installed && !additions.length) return;
        await withToolPackageRegistry(this.registryFile, async () => {
            const current = await readToolPackageRegistry(this.registryFile), previous = current.find(item => item.id === installed.registration.id);
            if (previous && previous.version !== installed.registration.version) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', `Package ${previous.id}@${previous.version} is already registered`);
            const next = current.filter(item => item.id !== installed.registration.id).concat(installed.registration);
            await this.implementations.save(installed.registration);
            await writeToolPackageRegistry(this.registryFile, next);
            try {await this.registrar!.registerTools(additions);}
            catch (error) {await writeToolPackageRegistry(this.registryFile, current); throw error;}
            this.records = next; this.installed.set(installed.registration.id, installed); this.failures.delete(installed.registration.id);
            this.notify();
        });
    }

    private async existingPackage(source: ToolPackageSource, current: RegisteredToolPackage): Promise<InstalledToolPackage> {
        if (await packageFingerprint(source, await packageFiles(source, current.bindings)) !== current.fingerprint)
            throw packageError('TOOL_PACKAGE_CONTENT_CONFLICT', `Package ${current.id}@${current.version} has changed without a new version`);
        return this.installed.get(current.id) ?? restoreToolPackage(this.packageDirectory(current), current, this.connectionsFor(current.id));
    }

    private async packageInfo(source: ToolPackageSource): Promise<ToolPackageInfo> {
        const {id, version, name, description, tools} = source.manifest;
        const current = this.sources.get(packageKey(source));
        const result: ToolPackageInfo = {id, version, name, description, tools: tools.map(tool => ({...tool})), status: 'available',
            ...await packageGuide(current ?? source, current && current.root !== source.root ? source : undefined)};
        Object.assign(result, this.packagePresentation(source));
        if (source.manifest.flows?.length) result.flowCount = source.manifest.flows.length;
        const failure = this.failures.get(id);
        if (failure) return {...result, status: 'failed', ...failure};
        if (this.installed.get(id)?.registration.version === version) {
            const declaration = this.declarations.get(packageKey(source)), installed = this.installed.get(id)!;
            const connections = declaration ? (await this.options.connections?.snapshot())?.connections ?? [] : [];
            if (declaration) result.configuration = {...this.preferences.get(packageKey(source)), tools: installed.tools.map(tool => ({id: tool.name, enableWith: declaration.tools[tool.name]?.enableWith, label: declaration.tools[tool.name]?.label, hidden: declaration.tools[tool.name]?.hidden, advanced: declaration.tools[tool.name]?.advanced,
                optionLabels: toolboxOptionLabels(declaration.tools[tool.name]?.parameters ?? [], connections),
                parameters: toolboxParameters(tool, declaration.tools[tool.name]?.parameters ?? [], connections)}))};
            return {...result, status: 'registered'};
        }
        try {await resolvePackageExecutables(source, this.env); return result;}
        catch (error) {return {...result, status: 'missing', ...failureReason(error, 'resolve')};}
    }

    private packagePresentation(source: ToolPackageSource): Partial<ToolPackageInfo> {
        const {id, version} = source.manifest, result: Partial<ToolPackageInfo> = {};
        const running = new Map<string, number>();
        for (const slot of this.slots.get(id)?.values() ?? []) for (const row of slot.counts()) running.set(row.version, (running.get(row.version) ?? 0) + row.count);
        result.runningVersions = [...running].filter(([runningVersion]) => runningVersion !== this.installed.get(id)?.registration.version).map(([version, count]) => ({version, count}));
        result.activationId = this.installed.get(id)?.registration.activationId;
        const ui = this.declarations.get(packageKey(source));
        const display = ui?.connections ? ui : [...this.sources.values()].filter(candidate => candidate.manifest.id === id).sort((a, b) => b.manifest.version.localeCompare(a.manifest.version, undefined, {numeric: true}))
            .map(candidate => this.declarations.get(packageKey(candidate))).find(Boolean) ?? ui;
        if (display?.connections) result.connectionMethods = display.connections;
        result.connectionTypes = [...new Set([...this.connectionOwners.get(id) ?? [], ...Object.keys(display?.connections ?? {}),
            ...Object.values(display?.tools ?? {}).flatMap(tool => tool.parameters.flatMap(field => field.connectionType ? [field.connectionType] : []))])];
        result.canSwitch = this.options.canManage !== false && this.sources.has(packageKey(source)) && !!this.installed.get(id) && this.installed.get(id)?.registration.version !== version && !this.pendingVersions.has(id);
        if (this.pendingVersions.has(id)) result.pendingVersion = this.pendingVersions.get(id);
        if (this.migrationWarnings.has(packageKey(source))) result.configurationWarning = this.migrationWarnings.get(packageKey(source));
        result.canUninstall = !this.pendingVersions.has(id) && this.options.canManage !== false && !ui?.preinstall && !!this.registrar?.unregisterTools && this.installed.get(id)?.registration.version === version;
        return result;
    }
    private addSource(source: ToolPackageSource): void {
        const key = packageKey(source), previous = this.sources.get(key);
        if (previous && previous.root !== source.root) throw packageError('TOOL_PACKAGE_CATALOG_CONFLICT', `Multiple catalog sources contain ${key}`);
        this.sources.set(key, source);
    }
    private connectionsFor(packageId: string): ToolConnectionAccess | undefined {
        const connections = this.options.connections;
        if (!connections) return undefined;
        return new Proxy(connections, {get: (target, key) => {
            if (key === 'register') return (type: Parameters<ToolConnectionAccess['register']>[0]) => {
                target.register(type);
                const ids = this.connectionOwners.get(packageId) ?? new Set<string>(); ids.add(type.id); this.connectionOwners.set(packageId, ids);
            };
            const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        }});
    }
    private activate(installed: InstalledToolPackage): boolean {
        if (installed.source.manifest.executionEnvironment === 'instance') return false;
        if (this.environments.has(installed.registration.id)) return false;
        this.environments.set(installed.registration.id, activatePackageEnvironment(installed.registration.bindings)); return true;
    }
    private packageDirectory(reference: {id: string; version: string}): string {return path.join(this.dataDirectory, reference.id, reference.version);}
    private record(operationId: string, stage: string, result: string, started: number, count: number, code?: string): void {
        const metadata = {operation: 'tool.package', operationId, stage, result, count, code, durationMs: Math.round(performance.now() - started)};
        if (result === 'failure' || result === 'partial') log.warn('tool.package', metadata); else log.info('tool.package', metadata);
    }
}

function packageKey(source: ToolPackageSource): string {return `${source.manifest.id}@${source.manifest.version}`;}
function assertToolVersion(dependency: FlowToolDependency, actual?: string): void {
    if (dependency.version !== undefined && dependency.version !== (actual ?? '1'))
        throw packageError('TOOL_PACKAGE_TOOL_VERSION_CONFLICT', `Tool ${dependency.id}@${actual ?? '1'} is already registered; requested ${dependency.version}`);
}
function assertRegisteredTool(dependency: FlowToolDependency, actual: ToolMeta): void {
    assertToolVersion(dependency, actual.version);
    if (!actual.enabled) throw packageError('TOOL_PACKAGE_TOOL_DISABLED', `Tool ${dependency.id} is disabled; enable it explicitly before installing this dependency`);
}
function failureReason(error: unknown, stage: string): {code: string; reason: string} {
    const code = (error as {code?: unknown})?.code;
    if (typeof code === 'string' && code.startsWith('TOOL_PACKAGE_') && /^[A-Z_]{1,80}$/.test(code) && error instanceof Error) return {code, reason: error.message};
    if (code === 'ENOENT') return {code: 'TOOL_PACKAGE_FILES_MISSING', reason: `Tool package ${stage} cannot find its declared files or executable; verify the trusted source and installed package`};
    if (code === 'EACCES' || code === 'EPERM') return {code: 'TOOL_PACKAGE_PERMISSION_DENIED', reason: `Tool package ${stage} lacks filesystem permission; check package and application data directory ownership`};
    if (code === 'ENOSPC') return {code: 'TOOL_PACKAGE_STORAGE_FULL', reason: `Tool package ${stage} has insufficient storage space`};
    if (error instanceof SyntaxError) return {code: 'TOOL_PACKAGE_MODULE_INVALID', reason: `Tool package ${stage} contains invalid JSON or module syntax`};
    if (error instanceof Error && error.name === 'DataCloneError') return {code: 'TOOL_PACKAGE_TOOL_INVALID', reason: 'Tool package exports invalid non-serializable tool metadata'};
    return {code: `TOOL_PACKAGE_${stage.toUpperCase().replace(/[^A-Z]/g, '_')}_FAILED`, reason: `Tool package ${stage} failed; verify the trusted package files and writable application data directory`};
}

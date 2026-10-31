import {ToolHistory} from './history';
import {stageVersionSwitch} from './version-switch';
import {migratePackageSettings} from './settings-migration';
import {ToolPreferences, validateSettings} from './preferences';
import {copyToolbox, readToolbox, toolboxParameters, validateToolDefaults, type ToolboxDeclaration} from './toolbox';
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
import {readToolPackageRegistry, withToolPackageRegistry, writeToolPackageRegistry, type RegisteredToolPackage} from './store';
import {activatePackageEnvironment, packageSourceEnvironment} from './environment';
import {readPackageFlows} from './flows';

const log = createModuleLogger('tool-packages');
interface Registrar {registerTools(tools: Tool[]): Promise<void>; unregisterTools?(ids: string[]): Promise<void>; toolCatalog: {getToolMeta(id: string): ToolMeta | undefined};}
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
        const work = this.tail.then(() => this.configurePackage(id, version, settings));
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
            this.record(operationId, stage, 'success', started, Object.keys(settings.defaults).length);
        } catch (error) {
            const failure = failureReason(error, 'configuration'); this.record(operationId, stage, 'failure', started, 0, failure.code);
            throw Object.assign(new Error(failure.reason), {code: failure.code});
        }
    }
    async history(id: string, version: string) {
        packageIdentity(id, 'id'); packageIdentity(version, 'version'); return this.historyStore.list(`${id}@${version}`);
    }
    switchVersion(id: string, version: string, expectedVersion: string): Promise<void> {
        const started = performance.now(), operationId = randomUUID();
        const work = this.tail.then(async () => {
            packageIdentity(id, 'id'); packageIdentity(version, 'version'); packageIdentity(expectedVersion, 'expected version');
            if (this.options.canManage === false) throw packageError('TOOL_PACKAGE_SWITCH_DENIED', 'Only the host administrator can switch shared package versions');
            const active = this.installed.get(id), source = this.sources.get(`${id}@${version}`);
            if (!active || active.registration.version !== expectedVersion || version === expectedVersion) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', 'Refresh the active package version before switching');
            if (!source || !this.registrar) throw packageError('TOOL_PACKAGE_SWITCH_UNAVAILABLE', 'The selected version is unavailable in the trusted host catalog');
            const selected = await stageVersionSwitch(source, active, this.packageDirectory(source.manifest), this.registryFile, this.env, this.registrar.toolCatalog);
            this.pendingVersions.set(id, selected.version);
            log.info('tool.package.version', {operationId, packageId: id, fromVersion: expectedVersion, toVersion: version, stage: 'prepare-version-switch', result: 'success', durationMs: Math.round(performance.now() - started)});
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
            if (this.historyStore.busy(key)) {await this.preferences.save(key, settings); throw packageError('TOOL_PACKAGE_BUSY', 'Wait for running tools before removing this package');}
            await withToolPackageRegistry(this.registryFile, async () => {
                const current = await readToolPackageRegistry(this.registryFile), next = current.filter(row => row.id !== id);
                if (current.find(row => row.id === id)?.version !== version) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', 'Registered version changed before uninstall');
                await writeToolPackageRegistry(this.registryFile, next);
                try {await this.registrar!.unregisterTools!(installed.tools.map(tool => tool.name));}
                catch (error) {await writeToolPackageRegistry(this.registryFile, current); throw error;}
                this.records = next; this.installed.delete(id); this.environments.get(id)?.(); this.environments.delete(id);
            });
            this.record(operationId, 'uninstall', 'success', started, installed.tools.length);
        }).catch(error => {this.record(operationId, 'uninstall', 'failure', started, 0, failureReason(error, 'uninstall').code); throw error;}); this.tail = work.catch(() => {}); return work;
    }
    userTools(tools: Tool[]): Tool[] {
        return tools.map(tool => {
            const installed = [...this.installed.values()].find(item => item.tools.some(entry => entry.name === tool.name));
            return installed && this.declarations.has(packageKey(installed.source)) ? userTool(tool, this.preferences, packageKey(installed.source), this.historyStore, this.declarations.get(packageKey(installed.source))?.tools[tool.name]?.enableWith) : tool;
        });
    }
    initialTools(): Tool[] {return [...this.installed.values()].flatMap(item => item.tools);}
    async flowTemplates(packageId: string, version: string) {
        packageIdentity(packageId, 'id'); packageIdentity(version, 'version'); await this.tail;
        const installed = this.installed.get(packageId);
        if (!installed || installed.registration.version !== version) throw packageError('TOOL_PACKAGE_NOT_REGISTERED', 'Register this package version before installing its workflows');
        if (await packageFingerprint(installed.source, await packageFiles(installed.source, installed.registration.bindings)) !== installed.registration.fingerprint)
            throw packageError('TOOL_PACKAGE_CONTENT_CONFLICT', 'Installed package resources differ from their registration');
        return readPackageFlows(installed.source);
    }
    bind(registrar: Registrar): void {
        for (const installed of this.installed.values()) this.activate(installed);
        this.registrar = registrar;
    }
    async close(): Promise<void> {
        await this.tail; await this.historyStore.close(); for (const release of this.environments.values()) release(); this.environments.clear(); this.registrar = undefined;
    }

    async list(): Promise<ToolPackageInfo[]> {
        await this.tail;
        this.pendingVersions.clear();
        for (const record of await readToolPackageRegistry(this.registryFile)) {
            const active = this.installed.get(record.id);
            if (active && active.registration.version !== record.version) this.pendingVersions.set(record.id, record.version);
        }
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
        });
        if (this.installed.get(installed.registration.id) === installed && !additions.length) return;
        await withToolPackageRegistry(this.registryFile, async () => {
            const current = await readToolPackageRegistry(this.registryFile), previous = current.find(item => item.id === installed.registration.id);
            if (previous && previous.version !== installed.registration.version) throw packageError('TOOL_PACKAGE_VERSION_CONFLICT', `Package ${previous.id}@${previous.version} is already registered`);
            const next = current.filter(item => item.id !== installed.registration.id).concat(installed.registration);
            await writeToolPackageRegistry(this.registryFile, next);
            try {await this.registrar!.registerTools(additions);}
            catch (error) {await writeToolPackageRegistry(this.registryFile, current); throw error;}
            this.records = next; this.installed.set(installed.registration.id, installed); this.failures.delete(installed.registration.id);
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
                optionLabels: Object.fromEntries((declaration.tools[tool.name]?.parameters ?? []).filter(field => field.connectionType).map(field => [field.name, Object.fromEntries(connections.filter(connection => connection.type === field.connectionType).map(connection => [connection.id, connection.name + ' (' + connection.id + ')']))])),
                parameters: toolboxParameters(tool, declaration.tools[tool.name]?.parameters ?? [], connections)}))};
            return {...result, status: 'registered'};
        }
        try {await resolvePackageExecutables(source, this.env); return result;}
        catch (error) {return {...result, status: 'missing', ...failureReason(error, 'resolve')};}
    }

    private packagePresentation(source: ToolPackageSource): Partial<ToolPackageInfo> {
        const {id, version} = source.manifest, result: Partial<ToolPackageInfo> = {};
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

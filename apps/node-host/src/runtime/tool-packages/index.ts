import {mkdir, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createModuleLogger, randomUUID} from '@itookit/common';
import type {FlowToolDependency, ToolDependencyResolver, ToolDependencyResult, ToolDependencyState, ToolPackageInfo} from '@itookit/app-contracts/services';
import type {Tool} from '@itookit/tools';
import type {ToolMeta} from '@itookit/tools/contracts';
import {discoverToolPackages, packageError, packageIdentity, toolPackageDirectories, type ToolPackageSource} from './manifest';
import {packageFiles, packageFingerprint, resolvePackageExecutables} from './files';
import {restoreToolPackage, stageToolPackage, type InstalledToolPackage} from './install';
import {readToolPackageRegistry, withToolPackageRegistry, writeToolPackageRegistry, type RegisteredToolPackage} from './store';
import {activatePackageEnvironment} from './environment';

const log = createModuleLogger('tool-packages');
interface Registrar {registerTools(tools: Tool[]): Promise<void>; toolCatalog: {getToolMeta(id: string): ToolMeta | undefined};}
export interface NodeToolPackageOptions {
    env?: NodeJS.ProcessEnv; directories?: string[]; dataDirectory?: string; registryFile?: string;
}

/** Executable locations come exclusively from a trusted host catalog and host environment. */
export class NodeToolPackages implements ToolDependencyResolver {
    private readonly env: NodeJS.ProcessEnv;
    private readonly registryFile: string;
    private dataDirectory: string;
    private readonly sources = new Map<string, ToolPackageSource>();
    private readonly installed = new Map<string, InstalledToolPackage>();
    private readonly failures = new Map<string, {code: string; reason: string}>();
    private records: RegisteredToolPackage[] = [];
    private registrar?: Registrar;
    private readonly environments = new Map<string, () => void>();
    private tail = Promise.resolve();

    constructor(private readonly options: NodeToolPackageOptions = {}) {
        this.env = options.env ?? process.env;
        this.dataDirectory = path.resolve(options.dataDirectory ?? path.join(this.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), 'mindos/tools'));
        this.registryFile = path.resolve(options.registryFile ?? path.join(this.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'mindos/tool-packages.json'));
    }

    async initialize(): Promise<void> {
        const operationId = randomUUID(), started = performance.now();
        try {
            await mkdir(this.dataDirectory, {recursive: true}); this.dataDirectory = await realpath(this.dataDirectory);
            for (const source of await discoverToolPackages(this.options.directories ?? toolPackageDirectories(this.env))) this.addSource(source);
            this.records = await readToolPackageRegistry(this.registryFile);
            for (const record of this.records) {
                try {this.installed.set(record.id, await restoreToolPackage(this.packageDirectory(record), record));}
                catch (error) {
                    const failure = failureReason(error, 'restore'); this.failures.set(record.id, failure);
                    this.record(operationId, 'restore-package', 'failure', started, 0, failure.code);
                }
            }
            this.record(operationId, 'restore', this.failures.size ? 'partial' : 'success', started, this.installed.size);
        } catch (error) {
            const failure = failureReason(error, 'restore'); this.record(operationId, 'restore', 'failure', started, 0, failure.code);
            throw Object.assign(new Error(failure.reason), {code: failure.code});
        }
    }

    initialTools(): Tool[] {return [...this.installed.values()].flatMap(item => item.tools);}
    bind(registrar: Registrar): void {
        for (const installed of this.installed.values()) this.activate(installed);
        this.registrar = registrar;
    }
    async close(): Promise<void> {
        await this.tail; for (const release of this.environments.values()) release(); this.environments.clear(); this.registrar = undefined;
    }

    async list(): Promise<ToolPackageInfo[]> {
        await this.tail;
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
            const installed = current ? await this.existingPackage(source, current) : await stageToolPackage(source, this.packageDirectory(reference), this.env);
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
            assertRegisteredTool({id: tool.name, version: tool.version ?? '1'}, existing); return false;
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
        return this.installed.get(current.id) ?? restoreToolPackage(this.packageDirectory(current), current);
    }

    private async packageInfo(source: ToolPackageSource): Promise<ToolPackageInfo> {
        const {id, version, name, description, tools} = source.manifest;
        const result: ToolPackageInfo = {id, version, name, description, tools: tools.map(tool => ({...tool})), status: 'available'};
        const failure = this.failures.get(id);
        if (failure) return {...result, status: 'failed', ...failure};
        if (this.installed.get(id)?.registration.version === version) {
            try {
                for (const tool of tools) {const meta = this.registrar?.toolCatalog.getToolMeta(tool.id); if (meta) assertRegisteredTool(tool, meta);}
                return {...result, status: 'registered'};
            } catch (error) {return {...result, status: 'failed', ...failureReason(error, 'resolve')};}
        }
        try {await resolvePackageExecutables(source, this.env); return result;}
        catch (error) {return {...result, status: 'missing', ...failureReason(error, 'resolve')};}
    }

    private addSource(source: ToolPackageSource): void {
        const key = packageKey(source), previous = this.sources.get(key);
        if (previous && previous.root !== source.root) throw packageError('TOOL_PACKAGE_CATALOG_CONFLICT', `Multiple catalog sources contain ${key}`);
        this.sources.set(key, source);
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

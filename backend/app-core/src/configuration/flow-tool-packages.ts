import {flowToolDependencyIssues} from '@itookit/llm-flow/contracts';
import {createModuleLogger, randomUUID} from '@itookit/common';
import type {FlowToolDependency, ToolDependencyResolver, ToolDependencyResult, ToolDependencyState, ToolPackages, ToolConnections, ToolPackageSettings, ToolPackageInfo} from '@itookit/app-contracts/services';
import type {IToolService} from '@itookit/tools/contracts';

type Catalog = Pick<IToolService, 'getToolMeta'>;
const log = createModuleLogger('tool-package-flows');
const errorCode = (error: unknown): string => typeof (error as {code?: unknown})?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test((error as {code: string}).code)
    ? (error as {code: string}).code : 'TOOL_PACKAGE_RESOURCES_FAILED';

/** Application adapters accept identities; only the host knows module and executable locations. */
export class FlowToolPackages implements ToolPackages {
    constructor(private readonly catalog: Catalog, private readonly resolver?: ToolDependencyResolver, readonly connections?: ToolConnections,
        private readonly restoreFlows?: (templates: import('@itookit/llm-flow/contracts').FlowDraft[]) => Promise<number>) {}
    assertRemovable?: (tools: string[]) => Promise<void>;
    existingFlowIds?: () => Promise<Set<string>>;
    onChange(listener: () => void): () => void {return this.resolver?.onChange?.(listener) ?? (() => {});}
    async switchVersion(id: string, version: string, expectedVersion: string, operationId?: string): Promise<void> {
        if (!this.resolver?.switchVersion) throw Object.assign(new Error('TOOL_PACKAGE_SWITCH_UNAVAILABLE'), {code: 'TOOL_PACKAGE_SWITCH_UNAVAILABLE'});
        await this.resolver.switchVersion(id, version, expectedVersion, operationId);
    }
    async history(id: string, version: string) {return this.resolver?.history?.(id, version) ?? [];}
    async uninstall(id: string, version: string): Promise<void> {
        if (!this.resolver?.uninstall) throw new Error('TOOL_PACKAGE_REMOVE_UNAVAILABLE');
        const item = (await this.list()).find(item => item.id === id && item.version === version);
        if (!item) throw new Error('TOOL_PACKAGE_NOT_FOUND');
        await this.assertRemovable?.(item.tools.map(tool => tool.id));
        await this.resolver.uninstall(id, version);
    }
    async configure(id: string, version: string, settings: ToolPackageSettings): Promise<void> {
        if (!this.resolver?.configure) throw new Error('TOOL_PACKAGE_CONFIGURATION_UNAVAILABLE');
        await this.resolver.configure(id, version, settings);
    }
    async installFlows(packageId: string, version: string): Promise<number> {
        const operationId = randomUUID(), started = Date.now(); let stage = 'read-templates';
        try {
            if (!this.resolver?.flowTemplates || !this.restoreFlows) throw Object.assign(new Error('TOOL_PACKAGE_RESOURCES_UNAVAILABLE'), {code: 'TOOL_PACKAGE_RESOURCES_UNAVAILABLE'});
            const templates = await this.resolver.flowTemplates(packageId, version);
            stage = 'restore-publish'; const installed = await this.restoreFlows(templates);
            log.info('tool.package.flows.install', {operationId, packageId, version, stage, result: 'success', count: installed, total: templates.length, durationMs: Date.now() - started});
            return installed;
        } catch (error) {
            log.warn('tool.package.flows.install', {operationId, packageId, version, stage, result: 'failure', code: errorCode(error), durationMs: Date.now() - started}); throw error;
        }
    }
    async list(): Promise<ToolPackageInfo[]> {
        const items = await this.resolver?.list?.() ?? [];
        if (!this.resolver?.flowTemplates || !this.existingFlowIds || !items.some(item => item.status === 'registered' && item.flowCount)) return items;
        const ids = await this.existingFlowIds();
        return Promise.all(items.map(item => this.flowResources(item, ids)));
    }
    private async flowResources(item: ToolPackageInfo, ids: Set<string>): Promise<ToolPackageInfo> {
        if (item.status !== 'registered' || !item.flowCount) return item;
        const operationId = randomUUID(), started = Date.now();
        try {
            const templates = await this.resolver!.flowTemplates!(item.id, item.version);
            return {...item, flowResources: templates.map(template => ({id: String(template.id), name: template.name, installed: ids.has(String(template.id))}))};
        } catch (error) {
            const code = errorCode(error);
            log.warn('tool.package.flows.status', {operationId, packageId: item.id, version: item.version, stage: 'read-templates', result: 'failure', code, durationMs: Date.now() - started});
            return {...item, flowResourceError: code};
        }
    }
    async ensure(dependencies: FlowToolDependency[]): Promise<ToolDependencyResult> {
        if (flowToolDependencyIssues(dependencies).length) throw Object.assign(new Error('Invalid tool dependency request'), {code: 'FLOW_TOOL_DEPENDENCY_INVALID'});
        const requested = structuredClone(dependencies);
        if (!requested.length) return {tools: []};
        if (!this.resolver) return {tools: requested.map(item => this.inspect(item))};
        const result = await this.resolver.ensure(requested);
        return {tools: requested.map(item => {
            const state = result.tools.find(value => value.id === item.id);
            return state?.status === 'ready' ? this.inspect(item) : state ?? {...item, status: 'failed', code: 'TOOL_REGISTRATION_INCOMPLETE', reason: 'Host did not report this tool'};
        })};
    }
    inspect(dependency: FlowToolDependency): ToolDependencyState {
        const metadata = this.catalog.getToolMeta(dependency.id);
        if (!metadata) return {...dependency, status: 'missing', code: 'TOOL_NOT_REGISTERED', reason: 'Tool is not registered in this host'};
        if (dependency.version !== undefined && metadata.version !== dependency.version) return {...dependency, status: 'failed', code: 'TOOL_VERSION_MISMATCH', reason: 'Registered tool version does not match the Flow dependency'};
        if (!metadata.enabled) return {...dependency, status: 'failed', code: 'TOOL_DISABLED', reason: 'Registered tool is disabled'};
        return {...dependency, ...(metadata.version ? {version: metadata.version} : {}), status: 'ready'};
    }
}

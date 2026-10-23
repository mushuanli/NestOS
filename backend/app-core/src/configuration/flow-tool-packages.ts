import {flowToolDependencyIssues} from '@itookit/llm-flow/contracts';
import type {FlowToolDependency, ToolDependencyResolver, ToolDependencyResult, ToolDependencyState, ToolPackages} from '@itookit/app-contracts/services';
import type {IToolService} from '@itookit/tools/contracts';

type Catalog = Pick<IToolService, 'getToolMeta'>;

/** Application adapters accept identities; only the host knows module and executable locations. */
export class FlowToolPackages implements ToolPackages {
    constructor(private readonly catalog: Catalog, private readonly resolver?: ToolDependencyResolver) {}
    list() {return this.resolver?.list?.() ?? Promise.resolve([]);}
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

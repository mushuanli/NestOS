import type {FlowDraft, FlowRevision, FlowToolDependency} from './flow-definition';
import type {FlowInputIssue} from './flow-inputs';

type Definition = Pick<FlowDraft | FlowRevision, 'nodes' | 'toolDependencies'> & {functions?: Definition[]};
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const version = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value);

/** Executable paths, URLs and installer arguments never belong to a Flow dependency. */
export function flowToolDependencyIssues(dependencies: unknown): FlowInputIssue[] {
    if (dependencies === undefined) return [];
    if (!Array.isArray(dependencies)) return [{code: 'invalid-tool-dependencies', message: 'Tool dependencies must be an array'}];
    const seen = new Set<string>();
    for (const item of dependencies) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !identifier(item.id)
            || item.version !== undefined && !version(item.version) || Object.keys(item).some(key => key !== 'id' && key !== 'version') || seen.has(item.id)) {
            return [{code: 'invalid-tool-dependencies', message: 'Tool dependencies require unique tool identities and optional versions'}];
        }
        seen.add(item.id);
    }
    return [];
}

/** Static deterministic calls provide compatibility; dynamic tool identities require declarations. */
export function collectFlowToolDependencies(flow: Definition): FlowToolDependency[] {
    const collected = new Map<string, FlowToolDependency>();
    const visit = (definition: Definition, depth: number): void => {
        if (depth > 32) throw dependencyError('FLOW_TOOL_DEPENDENCY_LIMIT', 'Flow tool dependency depth exceeded');
        if (flowToolDependencyIssues(definition.toolDependencies).length) throw dependencyError('FLOW_TOOL_DEPENDENCY_INVALID', 'Invalid Flow tool dependencies');
        const inferred = definition.nodes.flatMap(node => {
            const config = node.config && typeof node.config === 'object' && !Array.isArray(node.config) ? node.config : {};
            return node.plugin === 'builtin.tool' && identifier(config.toolId) ? [{id: config.toolId,
                ...(version(config.toolVersion) ? {version: config.toolVersion} : {})}] : [];
        });
        for (const item of [...definition.toolDependencies ?? [], ...inferred]) mergeDependency(collected, item);
        for (const child of definition.functions ?? []) visit(child, depth + 1);
    };
    visit(flow, 0); return [...collected.values()];
}

function mergeDependency(target: Map<string, FlowToolDependency>, item: FlowToolDependency): void {
    const previous = target.get(item.id);
    if (previous?.version && item.version && previous.version !== item.version) throw dependencyError('FLOW_TOOL_VERSION_CONFLICT', `Conflicting tool dependency versions: ${item.id}`);
    target.set(item.id, {id: item.id, ...(item.version ?? previous?.version ? {version: item.version ?? previous?.version} : {})});
}
function dependencyError(code: string, message: string): Error {return Object.assign(new Error(message), {code});}

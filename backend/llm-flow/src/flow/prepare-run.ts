import type { DagPluginCatalog, FlowRevision, JsonValue } from '../contracts';
import { checkFlowSyntax } from './syntax-check';
import { validateFlowParameters } from './parameters';
import { hasValidationErrors } from './validation';
import { flowToDag, type FlowNodeBinder } from './to-dag';

export interface FlowPreparationOptions {
    parameters?: Record<string, JsonValue>;
    plugins?: DagPluginCatalog;
    bindNode?: FlowNodeBinder;
    fallbackConnectionId?: string;
    connectionId?: string;
    connectionBindings?: Record<string, string>;
    resolveComposite?: (id: string, revision?: number) => Promise<FlowRevision | null>;
    prepareConnections?: (flow: FlowRevision, bindings?: Record<string, string>, connectionId?: string) => Promise<FlowRevision>;
}

/** Shared preparation boundary for standalone calls and durable conversation instructions. */
export async function prepareFlowRun(flow: FlowRevision, options: FlowPreparationOptions) {
    const issues = [...checkFlowSyntax(flow, { plugins: options.plugins }).diagnostics,
        ...validateFlowParameters(flow.parameters, options.parameters)];
    if (hasValidationErrors(issues)) throw new Error(issues.map(issue => issue.message).join('; '));
    return flowToDag(flow, options.bindNode, options.fallbackConnectionId, options.resolveComposite,
        [], flow.dependencyLocks, false, options.connectionId, options.connectionBindings, options.prepareConnections);
}

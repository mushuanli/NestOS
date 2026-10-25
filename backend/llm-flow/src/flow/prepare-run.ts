import type { DagPluginCatalog, FlowRevision, JsonValue, FlowCallSource } from '../contracts';
import { checkFlowSyntax } from './syntax-check';
import {prepareFlowCallInput, type FlowCallInputOptions} from './call-input';
import { hasValidationErrors } from './validation';
import { flowToDag, type FlowNodeBinder } from './to-dag';
import { assertRootCallable } from '../contracts/callable-exposure';

export interface FlowPreparationOptions {
    parameters?: Record<string, JsonValue>;
    inputSource?: FlowCallSource;
    inputOptions?: FlowCallInputOptions;
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
    assertRootCallable(flow);
    const issues = checkFlowSyntax(flow, { plugins: options.plugins }).diagnostics;
    if (hasValidationErrors(issues)) throw new Error(issues.map(issue => issue.message).join('; '));
    if (options.inputSource && options.parameters !== undefined) throw new Error('Flow parameters and inputSource cannot both be supplied');
    const input = prepareFlowCallInput(flow, options.inputSource ?? {kind: 'arguments', value: options.parameters ?? {}},
        {allowUndeclared: flow.parameters === undefined && !options.inputSource, ...options.inputOptions});
    return flowToDag(flow, options.bindNode, options.fallbackConnectionId, options.resolveComposite,
        [], flow.dependencyLocks, false, options.connectionId, options.connectionBindings, options.prepareConnections, input.parameters);
}

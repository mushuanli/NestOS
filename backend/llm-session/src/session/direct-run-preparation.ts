import type {ContextSnapshot} from '@itookit/llm-context';
import type {CapabilityBinding} from '@itookit/durable-kernel';
import type {TaskRunDefinition} from '@itookit/llm-flow';
import {invocationLabels, targetLabels} from '@itookit/llm-flow/contracts';
import type {LLMSkill} from '../contracts';
import {snapshotDirectAgentPolicy, type DirectAgentPolicy} from '../contracts/direct-agent-policy';
import {directTaskSpec, type DirectConversationInput, type DirectToolCatalog} from './direct-conversation';
import {directExecutionMode, directToolIds} from './direct-execution-mode';
import type {SessionHost} from '../utils/host-ports';

export interface DirectRunPreparation {
    execution: DirectConversationInput;
    snapshot: ContextSnapshot;
    catalog: DirectToolCatalog;
    skills?: LLMSkill[];
    policy?: DirectAgentPolicy;
    hasProgram(kind: string, version: string): boolean;
    translate: SessionHost['translate'];
}

/** Compile ready messages and policy into the existing serializable run definition, without admission. */
export function prepareDirectRun(input: DirectRunPreparation): TaskRunDefinition {
    const {execution, snapshot, catalog, skills = []} = input;
    assertDirectRunInput(execution);
    const harness = execution.config.execution?.kind === 'harness', tools = harness ? [] : directToolIds(execution.config, execution.task.input);
    const spec = directTaskSpec(execution, snapshot, catalog, skills, snapshotDirectAgentPolicy(input.policy));
    spec.labels = {...spec.labels, ...invocationLabels(execution.task.input.invocation), ...targetLabels(execution.config.target)};
    if (execution.task.input.invocation) spec.requestId = `invocation:${execution.task.input.invocation.invocationId}`;
    assertTools(execution, spec, input.translate);
    if (input.hasProgram(spec.program.kind, '2')) spec.program.version = '2';
    return structuredClone({kind: 'task', sessionId: execution.task.sessionId, task: spec, capabilities: capabilities(harness, tools)});
}
export function assertDirectRunInput(execution: DirectConversationInput): void {
    if (execution.config.execution?.kind === 'flow' || execution.config.type === 'flow' || execution.task.input.sendIntent?.execution.kind === 'flow')
        throw Object.assign(new Error('A Flow requires graph preparation and workspace settlement'), {code: 'CALL_GRAPH_PREPARATION_REQUIRED'});
}
function assertTools(execution: DirectConversationInput, spec: ReturnType<typeof directTaskSpec>, translate: SessionHost['translate']): void {
    if (execution.config.execution?.kind !== 'harness' && directExecutionMode(execution.task.input) === 'agent'
        && !('tools' in spec.input && spec.input.tools?.length))
        throw Object.assign(new Error(translate('chatInput.executionMode.noTools')), {code: 'AGENT_TOOLS_UNAVAILABLE'});
}
function capabilities(harness: boolean, tools: string[]): CapabilityBinding[] {
    return harness ? [{kind: 'harness', uri: 'harness://session', rights: ['execute'], signalKey: 'harnessHandleId'}]
        : [{kind: 'llm', uri: 'llm://session', rights: ['execute', 'write'], signalKey: 'llmHandleId'},
            ...(tools.length ? [{kind: 'tool', uri: 'tool://session', rights: ['execute'], signalKey: 'toolHandleId'} satisfies CapabilityBinding] : [])];
}

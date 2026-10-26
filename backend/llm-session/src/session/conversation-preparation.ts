import type {ContextSnapshot} from '@itookit/llm-context';
import type {TaskRunDefinition} from '@itookit/llm-flow';
import {snapshotDirectAgentPolicy, type DirectAgentPolicy} from '../contracts/direct-agent-policy';
import {createSessionHost, type SessionHost, type SessionHostPorts} from '../utils/host-ports';
import {ConversationContextBuilder, type ConversationContextInput, type ConversationContextOptions} from './conversation-context';
import {prepareDirectConversation, type DirectConversationPorts} from './direct-conversation';
import {directToolIds} from './direct-execution-mode';
import {prepareDirectRun, assertDirectRunInput} from './direct-run-preparation';

/** Ready host history and resolved target only; no UI state, controller or admitted Kernel Task. */
export type DirectConversationPreparationInput = ConversationContextInput;
export interface DirectConversationPreparationOptions extends ConversationContextOptions, DirectConversationPorts {
    directAgentPolicy?: DirectAgentPolicy;
    hostPorts?: SessionHostPorts;
    hasProgram(kind: string, version: string): boolean;
}
export type PreparedConversationContext = Pick<ContextSnapshot,
    'id' | 'taskRunId' | 'createdAt' | 'branchRef' | 'branchHead' | 'profile' | 'agent' | 'tokenCount' | 'digest'>;
export interface PreparedDirectConversationRun {definition: TaskRunDefinition; context: PreparedConversationContext}
interface Progress {stage: string; tokenCount?: number}

/** Resolve host materials once; the caller freezes this serializable result before submission. */
export async function prepareDirectConversationRun(input: DirectConversationPreparationInput,
    options: DirectConversationPreparationOptions): Promise<PreparedDirectConversationRun> {
    const host = createSessionHost(options.hostPorts), started = Date.now(), progress: Progress = {stage: 'input'};
    const identity = {operationId: safeId(input?.task?.id), sessionId: safeId(input?.task?.sessionId)};
    let outcome = 'failure', errorCode: string | undefined;
    try {
        const execution = snapshotInput(input), policy = snapshotDirectAgentPolicy(options.directAgentPolicy);
        assertDirectRunInput(execution); progress.stage = 'tools-and-skills';
        const prepared = await prepareDirectConversation(options, execution), builder = new ConversationContextBuilder(options, policy);
        progress.stage = 'context'; const location = await builder.resolveLocation(prepared.execution);
        const snapshot = await builder.assemble(prepared.execution, location, prepared.skillsPrompt);
        progress.tokenCount = snapshot.tokenCount; progress.stage = 'tool-catalog';
        const tools = directToolIds(prepared.execution.config, prepared.execution.task.input);
        const catalog = prepared.execution.config.execution?.kind === 'harness' ? {definitions: [], externalIds: []}
            : await options.resolveTools?.(execution.task.sessionId, tools) ?? {definitions: [], externalIds: []};
        progress.stage = 'compile';
        const definition = prepareDirectRun({execution: prepared.execution, snapshot, catalog, skills: prepared.skills, policy,
            hasProgram: options.hasProgram, translate: host.translate});
        outcome = 'success'; return {definition, context: provenance(snapshot)};
    } catch (error) {errorCode = safeCode(error); throw error;}
    finally {diagnose(host, identity, progress, outcome, errorCode, Date.now() - started);}
}
function snapshotInput(input: DirectConversationPreparationInput): DirectConversationPreparationInput {
    const task = input?.task;
    if (![task?.id, task?.sessionId, input?.roundId].every(value => typeof value === 'string' && !!value.trim())
        || !task?.input || task.input.sessionId !== undefined && task.input.sessionId !== task.sessionId)
        throw Object.assign(new Error('Direct preparation identity does not match its Session'), {code: 'CALL_PREPARATION_SCOPE_MISMATCH'});
    return {...structuredClone({roundId: input.roundId, config: input.config, contextFiles: input.contextFiles,
        ...(input.currentInput ? {currentInput: input.currentInput} : {}),
        task: {id: task.id, sessionId: task.sessionId, input: task.input, ...(task.frozen ? {frozen: task.frozen} : {})}}), log: input.log};
}
export function provenance(snapshot: ContextSnapshot): PreparedConversationContext {
    const {id, taskRunId, createdAt, branchRef, branchHead, profile, agent, tokenCount, digest} = snapshot;
    return structuredClone({id, taskRunId, createdAt, branchRef, branchHead, profile, agent, tokenCount, digest});
}
function diagnose(host: SessionHost, identity: {operationId?: string; sessionId?: string}, progress: Progress,
    outcome: string, errorCode: string | undefined, durationMs: number): void {
    const detail = {operation: 'session.direct.prepare', stage: progress.stage, outcome, errorCode, durationMs,
        ...identity, tokenCount: progress.tokenCount};
    try {if (outcome === 'success') host.logger.info('Direct run preparation', detail); else host.logger.warn('Direct run preparation', detail);}
    catch { /* Diagnostic failures never replace prepared data or the original rejection. */ }
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'DIRECT_PREPARATION_FAILED';
}

function safeId(value: unknown): string | undefined {return typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;}

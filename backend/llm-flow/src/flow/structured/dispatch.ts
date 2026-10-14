import { flowTemplateReferences } from '../../contracts';
import { assignmentUpdates } from '../variables';
import type { JsonValue } from '../../contracts';
import type { Decision, DurableTaskProgram, KernelAction, TaskInputEvent } from '@itookit/durable-kernel';
import { collectDependency, dependenciesReady, dependencyWait } from '@itookit/llm-tasks';
import { evaluate } from '../operations';
import { flowSchemaIssue } from '../schema-registry';
import { invalidFields, mergeInput } from './input';
import { createInvocation, dispatchView, invocationKey, resultValue } from './invocation';
import type { DispatchInput, DispatchState } from './types';
import { FlowReducerRegistry, orderedUpdates, projectSummary } from './join';
import { mergeResults } from './results';
import { validateDispatch } from './validation';
import { object, outcome } from './value';

type Step = Decision<DispatchState, unknown>;

export class FlowDispatchProgram implements DurableTaskProgram<DispatchState, DispatchInput, unknown> {
    constructor(private readonly reducers = new FlowReducerRegistry()) {}
    readonly manifest = { kind: 'flow.dispatch', version: '1' };

    init(input: DispatchInput): Step {
        validateDispatch(input);
        if (input.join && !this.reducers.has(input.join.reducer)) throw new Error(`Unknown reducer: ${input.join.reducer}`);
        const state: DispatchState = { ...structuredClone(input), phase: 'dependencies', round: 0,
            dependencyOutputs: {}, resolvedDependencyIds: [], results: {}, selected: [], spawned: [], received: {}, failures: {},
            inputRevision: input.inputRevision ?? '1', revisionSequence: 0, revisionValues: {}, consumedTokens: 0 };
        for (const [key, value] of Object.entries(input.initialResults ?? {})) {
            state.results[key] = { value, inputRevision: state.inputRevision, round: 0, taskId: 'initial' };
        }
        if (input.join && Object.keys(state.results).length) state.summary = this.reducers.reduce(input.join, undefined, state.results);
        return collectInputs(state);
    }

    reduce(current: Readonly<DispatchState>, event: TaskInputEvent): Step {
        const state = structuredClone(current) as DispatchState;
        if (state.phase === 'dependencies') {
            collectDependency(state.dependencies, state.dependencyOutputs, state.resolvedDependencyIds, event, 'result');
            return collectInputs(state);
        }
        if (state.phase === 'revision') return revise(state, event);
        if (state.phase === 'revision-task') return receiveRevision(state, event);
        receive(state, event);
        if (Object.keys(state.received).length + Object.keys(state.failures).length < state.selected.length) return spawnAvailable(state);
        if (Object.keys(state.failures).length && state.join?.failure !== 'partial') return { state, next: { type: 'fail', error: { message: JSON.stringify(state.failures) } } };
        const updates = orderedUpdates(state.selected, state.received);
        if (state.join) state.summary = this.reducers.reduce(state.join, state.summary, updates);
        state.results = mergeResults(state.results, updates);
        applyBranchAssignments(state);
        for (const key of Object.keys(state.failures)) if (state.results[key]) state.results[key].inputRevision = `failed:${state.inputRevision}`;
        const visibility = logicActions(state);
        const step = afterBatch(state);
        step.actions = [...visibility, ...(step.actions ?? [])];
        return step;
    }
}

function collectInputs(state: DispatchState): Step {
    if (!dependenciesReady(state.dependencies, state.resolvedDependencyIds)) return { state, next: dependencyWait(state.dependencies) };
    state.values = { ...state.values, ...object(state.dependencyOutputs.input) } as Record<string, JsonValue>;
    for (const [key, value] of Object.entries(state.dependencyOutputs)) if (key !== 'input') state.values[key] = value;
    state.phase = 'dispatch';
    return nextBatch(state);
}

function nextBatch(state: DispatchState): Step {
    state.phase = 'dispatch';
    if (evaluate(state.until, dispatchView(state))) {
        const step = complete(state, 'condition_met');
        step.actions = logicActions(state).filter(action => action.type === 'emit'
            && (action.payload as { phase: string }).phase === 'judge');
        return step;
    }
    if (state.round >= state.maxRounds) return complete(state, 'max_rounds');
    state.round++;
    const candidates = state.branches.filter(branch => !branch.when || evaluate(branch.when, dispatchView(state)));
    if (state.selectionOrder !== 'declared') candidates.sort((a, b) =>
        Number(state.results[a.key]?.inputRevision === state.inputRevision) - Number(state.results[b.key]?.inputRevision === state.inputRevision));
    state.selected = (state.mode === 'exclusive' ? candidates.slice(0, 1) : candidates).map(branch => branch.key);
    if (!state.selected.length) return { state, next: { type: 'fail', error: { message: 'Route selected no branch before its stop condition' } } };
    state.spawned = []; state.received = {}; state.failures = {};
    return spawnAvailable(state);
}

function spawnAvailable(state: DispatchState): Step {
    const settled = Object.keys(state.received).length + Object.keys(state.failures).length;
    const capacity = (state.maxConcurrency ?? state.selected.length) - state.spawned.length + settled;
    const additions = state.selected.filter(key => !state.spawned.includes(key)).slice(0, capacity);
    const group = additions.length > 1 ? `${state.invocationNamespace}:${state.round}:${state.spawned.length}` : undefined;
    const actions: KernelAction[] = additions.map(key => {
        const spec = createInvocation(state, state.branches.find(branch => branch.key === key)!);
        if (group) spec.labels = { ...spec.labels, flowHistoryGroup: group };
        return { type: 'spawn', spawnKey: invocationKey(state, key), spec };
    });
    state.spawned.push(...additions);
    const pending = state.spawned.filter(key => !state.received[key] && !state.failures[key]);
    return { state, actions, next: { type: 'wait', on: { type: 'any',
        waits: pending.map(key => ({ type: 'child', spawnKey: invocationKey(state, key) })) } } };
}

function receive(state: DispatchState, event: TaskInputEvent): void {
    if (event.type !== 'task-exited') return;
    const key = state.spawned.find(key => invocationKey(state, key) === event.spawnKey);
    if (!key || state.received[key] || state.failures[key]) return;
    const usage = object(object(event.exit.output).usage);
    const tokens = usage.total_tokens ?? usage.totalTokens;
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) state.consumedTokens += tokens;
    if (event.exit.status !== 'succeeded') { state.failures[key] = event.exit.error?.message || event.exit.status; return; }
    const branch = state.branches.find(branch => branch.key === key)!;
    try {
        const value = resultValue(event.exit.output, branch);
        const contract = state.invocationDefaults?.outputContract;
        const sharedIssue = contract?.schema !== undefined ? flowSchemaIssue(contract.schema, value) : undefined;
        if (sharedIssue || (contract?.validate && !evaluate(contract.validate, { value }))) throw new Error(sharedIssue ?? 'Shared output constraint failed');
        const issue = branch.outputSchema !== undefined ? flowSchemaIssue(branch.outputSchema, value) : undefined;
        if (issue || (branch.validate && !evaluate(branch.validate, { value }))) throw new Error(issue ?? 'Output constraint failed');
        state.received[key] = { value, taskId: event.taskId, inputRevision: state.inputRevision, round: state.round };
    } catch (error) { state.failures[key] = String(error); }
}

function afterBatch(state: DispatchState): Step {
    if (evaluate(state.until, dispatchView(state))) return complete(state, 'condition_met');
    if (state.round >= state.maxRounds) return complete(state, 'max_rounds');
    if (!state.revision) return nextBatch(state);
    if (state.revision.invocation) return spawnRevision(state);
    state.phase = 'revision'; state.revisionValues = {};
    return requestRevision(state);
}

function requestRevision(state: DispatchState): Step {
    const id = `revision-${++state.revisionSequence}`;
    return { state, actions: [{ type: 'request-interaction', interaction: { id, kind: 'input',
        prompt: state.revision!.prompt, payload: { fields: state.revision!.fields, state: dispatchView(state) } as unknown as JsonValue } }],
        next: { type: 'wait', on: { type: 'interaction', id } } };
}

function revise(state: DispatchState, event: TaskInputEvent): Step {
    const id = `revision-${state.revisionSequence}`;
    if (event.type !== 'interaction-resolved' || event.interactionId !== id) return { state, next: { type: 'wait', on: { type: 'interaction', id } } };
    const fields = state.revision!.fields;
    mergeInput(fields, state.revisionValues, event.value, Object.keys(fields));
    if (invalidFields(fields, state.revisionValues).length) return requestRevision(state);
    const changed = Object.entries(state.revisionValues).some(([key, value]) => JSON.stringify(state.values[key]) !== JSON.stringify(value));
    state.values = { ...state.values, ...state.revisionValues };
    if (changed) state.inputRevision = `${state.inputRevision}:${state.round}`;
    state.phase = 'dispatch';
    return nextBatch(state);
}

function spawnRevision(state: DispatchState): Step {
    const branch = state.revision!.invocation!;
    state.phase = 'revision-task';
    const spawnKey = invocationKey(state, branch.key);
    const spec = createInvocation({ ...state, invocationDefaults: undefined }, branch);
    return { state, actions: [{ type: 'spawn', spawnKey, spec }], next: { type: 'wait', on: { type: 'child', spawnKey } } };
}

function receiveRevision(state: DispatchState, event: TaskInputEvent): Step {
    const branch = state.revision!.invocation!, spawnKey = invocationKey(state, branch.key);
    if (event.type !== 'task-exited' || event.spawnKey !== spawnKey) return { state, next: { type: 'wait', on: { type: 'child', spawnKey } } };
    if (event.exit.status !== 'succeeded') return { state, next: { type: 'fail', error: { message: `Revision failed: ${event.exit.error?.message ?? event.exit.status}` } } };
    try {
        const value = resultValue(event.exit.output, branch);
        const issue = branch.outputSchema ? flowSchemaIssue(branch.outputSchema, value) : undefined;
        if (issue || (branch.validate && !evaluate(branch.validate, { value }))) throw new Error(issue ?? 'Revision constraint failed');
        const updates: Record<string, JsonValue> = {};
        mergeInput(state.revision!.fields, updates, value, Object.keys(state.revision!.fields));
        const invalid = invalidFields(state.revision!.fields, updates);
        if (invalid.length) throw new Error(`Invalid revision fields: ${invalid.join(', ')}`);
        const usage = object(object(event.exit.output).usage), tokens = usage.total_tokens ?? usage.totalTokens;
        if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) state.consumedTokens += tokens;
        const changed = Object.entries(updates).some(([key, value]) => JSON.stringify(state.values[key]) !== JSON.stringify(value));
        const hasAssignments = Object.keys(branch.assign ?? {}).length > 0;
        if (hasAssignments) {
            const patch = assignmentUpdates(branch.assign, value, { param: state.initialParameters ?? state.values, vars: state.variableValues }, state.variables ?? {});
            updateVariables(state, patch, event.taskId, branch.key);
        } else state.values = { ...state.values, ...updates };
        if (changed && !hasAssignments) state.inputRevision = `${state.inputRevision}:${state.round}`;
        (state.revisions ??= []).push({ taskId: event.taskId, round: state.round, inputRevision: state.inputRevision, values: updates });
        return nextBatch(state);
    } catch (error) { return { state, next: { type: 'fail', error: { message: String(error) } } }; }
}

function complete(state: DispatchState, stopReason: string): Step {
    const summary = state.summary === undefined ? {} : { summary: projectSummary(state.join, state.summary) };
    return { state, next: { type: 'complete', output: { ...outcome({ ...dispatchView(state), ...summary, ...(state.revisions ? { revisions: state.revisions } : {}), ...(state.variableChanges ? { variableChanges: state.variableChanges } : {}), ...(state.join ? { failures: state.failures } : {}), completedRounds: state.round, stopReason }),
        usage: { total_tokens: state.consumedTokens } } } };
}

function updateVariables(state: DispatchState, updates: Record<string, JsonValue>, taskId: string, nodeId: string): void {
    (state.variableChanges ??= []).push({ taskId, nodeId, round: state.round, updates: structuredClone(updates) });
    const changed = new Set(Object.entries(updates).filter(([key, value]) => JSON.stringify(state.variableValues?.[key]) !== JSON.stringify(value)).map(([key]) => key));
    state.variableValues = { ...state.variableValues, ...updates };
    const affectsInputs = state.branches.some(branch => flowTemplateReferences([state.invocationDefaults?.prompt, branch.prompt, branch.input, branch.target.inputs])
        .some(ref => ref.root === 'vars' && changed.has(ref.path[0])));
    if (affectsInputs) state.inputRevision = `${state.inputRevision}:${state.round}`;
}
function applyBranchAssignments(state: DispatchState): void {
    const updates: Record<string, JsonValue> = {};
    const commits: Array<{ key: string; patch: Record<string, JsonValue> }> = [];
    for (const key of state.selected) {
        const branch = state.branches.find(item => item.key === key)!;
        if (!branch.assign || !state.received[key]) continue;
        const patch = assignmentUpdates(branch.assign, state.received[key].value,
            { param: state.initialParameters ?? state.values, vars: state.variableValues }, state.variables ?? {});
        for (const name of Object.keys(patch)) if (Object.hasOwn(updates, name)) throw new Error(`Concurrent variable assignment: ${name}`);
        Object.assign(updates, patch);
        commits.push({ key, patch });
    }
    for (const { key, patch } of commits) updateVariables(state, patch, state.received[key].taskId, key);
}

/** Emit in the same commit as the reducer decision, so replay cannot duplicate history. */
function logicActions(state: DispatchState): KernelAction[] {
    const matched = evaluate(state.until, dispatchView(state));
    const stopReason = matched ? 'condition_met' : state.round >= state.maxRounds ? 'max_rounds' : 'continue';
    const nodes = state.logicNodes;
    const phase = (kind: 'aggregate' | 'judge', result: unknown): KernelAction => ({ type: 'emit',
        eventType: 'flow.logic.completed', payload: {
            nodeId: nodes?.[kind].id ?? kind, name: nodes?.[kind].name ?? kind,
            phase: kind, round: state.round, result,
        } });
    return [phase('aggregate', { reducer: state.join?.reducer ?? 'latest',
        results: dispatchView(state).results, summary: state.summary ?? null, failures: state.failures }),
    phase('judge', { condition: state.until, matched, round: state.round, maxRounds: state.maxRounds,
        results: dispatchView(state).results, stopReason })];
}

import { extractNodeOutput } from '@itookit/llm-tasks';
import { renderFlowText, renderFlowTemplate } from '../../contracts';
import type { JsonValue } from '../../contracts';
import type { TaskSpec } from '@itookit/durable-kernel';
import { resolve } from '../operations';
import type { DispatchState, PreparedBranch } from './types';
import { json, object } from './value';

export function invocationKey(state: DispatchState, key: string): string { return `${state.round}:${key}`; }

export function dispatchView(state: DispatchState) {
    const results = Object.fromEntries(Object.entries(state.results).map(([key, slot]) => [key,
        { ...slot, current: slot.inputRevision === state.inputRevision }]));
    return { ...(state.referenceNodes ? { nodes: state.referenceNodes } : {}), inputs: state.values, ...(state.variableValues ? { vars: state.variableValues } : {}), results, round: state.round, inputRevision: state.inputRevision, ...(state.summary !== undefined ? { summary: state.summary } : {}) };
}

export function createInvocation(state: DispatchState, branch: PreparedBranch): TaskSpec {
    const snapshot = { param: state.initialParameters ?? state.values, vars: state.variableValues, state: dispatchView(state), nodes: state.referenceNodes, iteration: { round: state.round } };
    const values = { ...object(renderFlowTemplate(branch.target.inputs, snapshot)), ...Object.fromEntries(Object.entries(branch.input).map(([key, expression]) => {
        const value = resolve(expression, dispatchView(state));
        if (value === undefined) throw new Error(`Missing dispatch input: ${branch.key}.${key}`);
        return [key, value];
    })) };
    const task = structuredClone(branch.task);
    task.labels = { ...task.labels, dispatchKey: branch.key, dispatchRound: String(state.round),
        flowHistory: (branch.publishToHistory ?? state.publishToHistory) ? 'publish' : 'omit' };
    if (task.program.kind === 'llm.agent' || task.program.kind === 'llm.chat') {
        const context = branch.context ?? state.invocationDefaults?.context ?? state.context;
        const prompt = invocationPrompt(state, branch, values);
        const messages = [...branch.instructions.map(content => ({ role: 'system', content })),
            ...(branch.instruction ? [{ role: 'system', content: branch.instruction }] : []),
            ...(context.history === 'explicit' ? context.messages ?? [] : []),
            { role: 'user', content: prompt }];
        task.input = { ...object(task.input), roundId: `${state.invocationNamespace}:${invocationKey(state, branch.key)}`,
            messages, includeDependencyOutputs: false, dependencyBindings: [] };
    } else if (task.program.kind === 'flow.value') task.input = { ...object(task.input), inputs: values };
    else if (task.program.kind === 'flow.input') task.input = { ...object(task.input), values };
    else task.input = { ...object(task.input), ...values };
    return json(task);
}

export function resultValue(output: unknown, branch: PreparedBranch): JsonValue {
    const source = branch.output ? resolve(branch.output, { output }) : branch.outputFormat === 'json' ? extractNodeOutput(output, 'result') : output;
    if (source === undefined) throw new Error(`Missing dispatch output: ${branch.key}`);
    return branch.outputFormat === 'json' && typeof source === 'string' ? JSON.parse(source) as JsonValue : json(source) as JsonValue;
}

function invocationPrompt(state: DispatchState, branch: PreparedBranch, values: Record<string, unknown>): string {
    const templates = [state.invocationDefaults?.prompt, branch.prompt].filter((value): value is string => value !== undefined);
    const view = dispatchView(state);
    const context = { nodes: state.referenceNodes, param: state.initialParameters ?? { ...state.values, ...values }, vars: state.variableValues, state: view, iteration: { round: state.round } };
    const prompt = templates.length ? templates.map(template => renderFlowText(template, context)).join('\n\n') : JSON.stringify(values);
    const schema = branch.outputSchema;
    return schema ? `${prompt}\n\nReturn only a JSON result matching the schema below, not the schema itself. Schema keywords are constraints, not output fields. Do not add fields forbidden by the schema.\nSchema:\n${JSON.stringify(schema)}` : prompt;
}

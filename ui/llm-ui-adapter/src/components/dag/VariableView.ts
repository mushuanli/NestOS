import { escapeHTML, t } from '@itookit/common';
import type { DurableFlowSnapshot } from '@itookit/llm-flow/contracts';

/** Show persisted outer variables and the live state of isolated dispatch scopes. */
export function renderVariables(snapshot: DurableFlowSnapshot): string {
    const state = snapshot.variables;
    if (!state || !Object.keys(state.initial).length) return '';
    const current = structuredClone(state.initial);
    for (const entry of state.commits) Object.assign(current[entry.scope] ??= {}, entry.updates);
    const scopes = snapshot.taskTree.flatMap(task => {
        const input = task.state as { variableValues?: unknown; variableChanges?: unknown } | undefined;
        return input?.variableValues ? [{ taskId: task.id, vars: input.variableValues, changes: input.variableChanges }] : [];
    });
    const items = [['initial', state.initial], ['current', { scopes: current, tasks: scopes }], ['changes', state.commits]] as const;
    return `<details class="dag-output"><summary>${escapeHTML(t('flow.variables.title'))}</summary>${items.map(([key, value]) =>
        `<h4>${escapeHTML(t(`flow.variables.${key}`))}</h4><pre>${escapeHTML(JSON.stringify(value, null, 2))}</pre>`).join('')}</details>`;
}

import { escapeHTML, t } from '@itookit/common';
import { type FlowDraft, type FlowNodeDefinition } from '@itookit/llm-flow/contracts';
import { renderFlowTemplate } from '@itookit/llm-flow/contracts';

/** Authoring helpers only; neither preview nor variable insertion invokes a model. */
export function enhanceInvocationEditor(root: HTMLElement, draft: FlowDraft, node: FlowNodeDefinition, allowPreview = true): void {
    const config = record(node.config);
    const parentId = draft.edges.find(edge => edge.to === node.id && draft.nodes.some(item => item.id === edge.from && item.plugin === 'builtin.route'))?.from;
    const parent = draft.nodes.find(item => item.id === parentId);
    const toolbar = document.createElement('div');
    toolbar.className = 'dag-inspector__actions';
    const variables = referenceOptions(draft, node);
    toolbar.innerHTML = `<label>${escapeHTML(t('flow.editor.variables'))}<select data-variable><option value=""></option>${variables.map(value => `<option>${escapeHTML(value)}</option>`).join('')}</select></label>
        ${allowPreview ? `<button type="button" data-preview>${escapeHTML(t('flow.editor.preview'))}</button>` : ''}<pre data-prompt-preview hidden></pre>`;
    if (parent) {
        const label = document.createElement('small');
        label.textContent = `${t('flow.editor.inherited')} ${parent.name}`;
        toolbar.prepend(label);
    }
    root.prepend(toolbar);
    let active: HTMLInputElement | HTMLTextAreaElement | undefined;
    root.addEventListener('focusin', event => {
        if ((event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) && event.target.dataset.schemaPath) active = event.target;
    });
    toolbar.querySelector('select')!.addEventListener('change', event => {
        const select = event.target as HTMLSelectElement;
        if (active && select.value) { active.setRangeText(select.value, active.selectionStart ?? active.value.length, active.selectionEnd ?? active.value.length, 'end'); active.dispatchEvent(new Event('input', { bubbles: true })); }
        select.value = '';
    });
    toolbar.querySelector('[data-preview]')?.addEventListener('click', () => preview(root, toolbar, draft, config, parent));
}

function preview(root: HTMLElement, toolbar: HTMLElement, draft: FlowDraft, config: Record<string, unknown>, parent?: FlowNodeDefinition): void {
    const read = (path: string, fallback: unknown) => root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-schema-path="${path}"]`)?.value || fallback;
    const defaults = record(config.invocationDefaults ?? record(parent?.config).invocationDefaults);
    const system = read('$.systemPrompt', config.systemPrompt ?? config.instruction ?? '');
    const prompt = read('$.invocationDefaults.prompt', defaults.prompt ?? '');
    const local = read('$.instruction', config.instruction ?? read('$.prompt', config.prompt ?? ''));
    const param = Object.fromEntries((draft.parameters ?? []).filter(item => item.default !== undefined).map(item => [item.name, item.default]));
    const output = toolbar.querySelector<HTMLElement>('[data-prompt-preview]')!;
    const template = [prompt, local].filter(Boolean).join('\n\n');
    try { output.textContent = `system:\n${String(system)}\n\nuser:\n${String(renderFlowTemplate(template, { param }))}`; }
    catch (error) { output.textContent = `system:\n${String(system)}\n\nuser:\n${template}\n\n${String(error)}`; }
    output.hidden = false;
}
function referenceOptions(draft: FlowDraft, editing: FlowNodeDefinition): string[] {
    const currentScope = scopeRoute(draft, editing.id);
    const options = new Set((draft.parameters ?? []).map(item => `\${param.${item.name}}`));
    for (const key of Object.keys(draft.variables ?? {})) options.add(`\${vars.${key}}`);
    for (const node of draft.nodes) {
        const config = record(node.config);
        if (node.plugin === 'builtin.input') for (const key of Object.keys(record(config.param ?? config.fields))) options.add(`\${param.${key}}`);
        if (node.plugin === 'builtin.agent' && node.id !== editing.id) {
            const schema = record(record(record(config.responseFormat).json_schema).schema);
            for (const field of Object.keys(record(schema.properties))) options.add(`\${nodes.${node.id}.outputs.result.${field}}`);
            options.add(`\${nodes.${node.id}.outputs.result}`);
        } else if (node.plugin === 'builtin.check') {
            const key = String(config.key ?? node.id);
            const route = draft.nodes.find(item => draft.edges.some(edge => edge.from === item.id && edge.to === node.id));
            const contract = record(config.outputContract ?? record(record(route?.config).invocationDefaults).outputContract);
            for (const field of Object.keys(record(record(contract.schema ?? config.outputSchema).properties))) {
                const owner = scopeRoute(draft, node.id);
                const judge = draft.nodes.find(item => item.plugin === 'builtin.judge' && scopeRoute(draft, item.id) === owner);
                if (currentScope && currentScope === owner) options.add(`\${state.results.${key}.value.${field}}`);
                else if (judge) options.add(`\${nodes.${judge.id}.outputs.result.results.${key}.value.${field}}`);
            }
        } else if (node.plugin === 'builtin.aggregate' && node.pluginVersion === '2.0.0') {
            if (currentScope && currentScope === scopeRoute(draft, node.id)) options.add('${state.summary}');
        } else if (node.id !== editing.id && node.plugin !== 'builtin.route'
            && !(node.plugin === 'builtin.judge' && currentScope === scopeRoute(draft, node.id))) options.add(`\${nodes.${node.id}.outputs.result}`);
    }
    options.add('${iteration.round}');
    return [...options];
}
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scopeRoute(draft: FlowDraft, id: string): string | undefined {
    const pending = [id], seen = new Set<string>();
    while (pending.length) {
        const current = pending.shift()!;
        if (seen.has(current)) continue;
        seen.add(current);
        const node = draft.nodes.find(item => item.id === current);
        if (node?.plugin === 'builtin.route') return current;
        if (!node || !['builtin.check', 'builtin.aggregate', 'builtin.judge', 'builtin.revise'].includes(node.plugin)) continue;
        pending.push(...draft.edges.filter(edge => edge.to === current && edge.output !== 'repeat').map(edge => edge.from));
    }
    return undefined;
}

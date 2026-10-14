// @file: llm-ui/components/dag/FlowSettingsDialog.ts
// Flow-level settings modal: named connection slots (bound to global LLM
// connections + one default) and declared runtime parameters with defaults.

import type { FlowConnection, FlowVariables, FlowDefaults, FlowParameter, FlowRunPolicy, JsonValue } from '@itookit/llm-flow/contracts';
import { escapeHTML, t } from '@itookit/common';

export interface FlowSettingsOptions {
    outputs?: import('@itookit/llm-flow/contracts').FlowDraft['outputs'];
    connections: FlowConnection[];
    defaultConnection?: string;
    parameters: FlowParameter[];
    variables?: FlowVariables;
    /** Global LLM connections available to bind a slot to. */
    availableConnections: Array<{ id: string; name: string }>;
    defaults?: FlowDefaults;
    runPolicy?: FlowRunPolicy;
    agents?: EntityOption[];
    systemPrompts?: EntityOption[];
    tools?: EntityOption[];
    skills?: EntityOption[];
}

export interface EntityOption { id: string; name: string; description?: string }

export interface FlowSettingsResult {
    outputs?: import('@itookit/llm-flow/contracts').FlowDraft['outputs'];
    connections: FlowConnection[];
    defaultConnection?: string;
    parameters: FlowParameter[];
    variables?: FlowVariables;
    defaults?: FlowDefaults;
    runPolicy?: FlowRunPolicy;
}

const PARAM_TYPES: FlowParameter['type'][] = ['string', 'number', 'boolean', 'json'];

/** Open the flow settings modal; resolve to the edited settings or null on cancel. */
export function openFlowSettings(options: FlowSettingsOptions): Promise<FlowSettingsResult | null> {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'dag-dialog dag-settings';
        dialog.innerHTML = `<form method="dialog">
            <h2>Flow settings</h2>
            ${defaultsSection(options)}
            ${runPolicySection(options.runPolicy)}
            <fieldset>
                <legend>Connections</legend>
                <div data-connections>${options.connections.map(connection => connectionRow(connection, options.availableConnections, options.defaultConnection)).join('')}</div>
                <button type="button" data-add-connection class="dag-settings__add">Add connection</button>
            </fieldset>
            <fieldset>
                <legend>Parameters</legend>
                <div data-parameters>${options.parameters.map(parameterRow).join('')}</div>
                <button type="button" data-add-parameter class="dag-settings__add">Add parameter</button>
            </fieldset>
            <fieldset><legend>${escapeHTML(t('flow.variables.title'))}</legend>
                <p>${escapeHTML(t('flow.variables.hint'))}</p>
                <textarea data-variables rows="6">${escapeHTML(JSON.stringify(options.variables ?? {}, null, 2))}</textarea>
            </fieldset>
            <p data-dialog-error class="dag-dialog__error"></p>
            <label>${escapeHTML(t('flow.invoke.outputs'))}<textarea data-outputs rows="5">${escapeHTML(JSON.stringify(options.outputs ?? {}, null, 2))}</textarea></label>
            <menu><button value="cancel">Cancel</button><button value="save">Save settings</button></menu>
        </form>`;
        document.body.append(dialog);
        bindRowControls(dialog, options);
        dialog.showModal();
        dialog.addEventListener('close', () => {
            if (dialog.returnValue !== 'save') { dialog.remove(); resolve(null); return; }
            try {
                const result = readSettings(dialog);
                dialog.remove();
                resolve(result);
            } catch (error) {
                dialog.querySelector<HTMLElement>('[data-dialog-error]')!.textContent =
                    error instanceof Error ? error.message : 'Invalid settings';
                dialog.showModal();
            }
        });
    });
}

function runPolicySection(policy: FlowRunPolicy = {}): string {
    const workspace: Partial<NonNullable<FlowRunPolicy['workspace']>> = policy.workspace ?? {};
    return `<fieldset class="dag-settings__run-policy">
        <legend>Run limits & workspace</legend>
        <p class="dag-settings__hint">为动态 spawn、并行执行和长任务设置安全边界。留空表示使用运行时默认值。</p>
        <div class="dag-settings__grid">
            <label>Max nodes<input data-run-max-nodes type="number" min="1" value="${policy.maxNodes ?? ''}" placeholder="1000"></label>
            <label>Max concurrency<input data-run-max-concurrency type="number" min="1" value="${policy.maxConcurrency ?? ''}" placeholder="Unlimited"></label>
            <label>Run timeout (ms)<input data-run-timeout type="number" min="1" value="${policy.timeoutMs ?? ''}" placeholder="Unlimited"></label>
            <label>Token budget<input data-run-max-tokens type="number" min="1" value="${policy.maxTokens ?? ''}" placeholder="Unlimited"></label>
            <label>Workspace mode${optionSelect('run-workspace-mode', workspace.mode, ['shared', 'read-only', 'worktree'])}</label>
            <label>Merge policy${optionSelect('run-workspace-merge', workspace.merge, ['manual', 'auto-if-clean', 'discard'])}</label>
            <label>Cleanup${optionSelect('run-workspace-cleanup', workspace.cleanup, ['on-success', 'always', 'keep'])}</label>
            <label>Base revision<input data-run-workspace-base value="${escapeHTML(workspace.base ?? '')}" placeholder="current / head / revision"></label>
        </div>
    </fieldset>`;
}

function defaultsSection(options: FlowSettingsOptions): string {
    const value = options.defaults ?? {};
    return `<fieldset class="dag-settings__defaults">
        <legend>Agent defaults</legend>
        <p class="dag-settings__hint">节点未单独设置时继承这里的值；留空则继续继承当前 Session Agent。</p>
        <div class="dag-settings__grid">
            <label>Default Agent${entitySelect('default-agent', value.agentId, options.agents ?? [], 'Inherit session agent')}</label>
            <label>System Prompt${entitySelect('default-system-prompt', value.systemPromptId, options.systemPrompts ?? [], 'Inherit agent prompt')}</label>
            <label>Connection slot${slotSelect(options.connections, value.connectionId)}</label>
            <label>Model<input data-default-model value="${escapeHTML(value.modelName ?? '')}" placeholder="Inherit model"></label>
            <label>Temperature<input data-default-temperature type="number" step="0.1" min="0" max="2" value="${value.temperature ?? ''}" placeholder="Inherit"></label>
            <label>Max tokens<input data-default-max-tokens type="number" min="1" value="${value.maxTokens ?? ''}" placeholder="Inherit"></label>
            <label>Thinking${triStateSelect('default-thinking', value.thinking)}</label>
            <label>Streaming${triStateSelect('default-stream', value.stream)}</label>
            <label>Web search${triStateSelect('default-web-search', value.webSearch)}</label>
            <label>Reasoning effort${optionSelect('default-reasoning', value.reasoningEffort, ['low', 'medium', 'high', 'xhigh'])}</label>
            <label>Approval${optionSelect('default-approval', value.approval, ['none', 'external', 'all'])}</label>
            <label>History${optionSelect('default-history', value.historyPolicy, ['inherit', 'upstream', 'none'])}</label>
            <label>System prompt policy${optionSelect('default-system-policy', value.systemPromptPolicy, ['inherit', 'replace', 'none'])}</label>
            <label>Persist output${triStateSelect('default-persist-output', value.persistOutput)}</label>
            <label>Max exchanges<input data-default-max-exchanges type="number" min="1" value="${value.maxExchanges ?? ''}" placeholder="Inherit"></label>
            <label>Timeout (ms)<input data-default-timeout type="number" min="1000" value="${value.timeoutMs ?? ''}" placeholder="Inherit"></label>
            <label>Working directory<input data-default-working-directory value="${escapeHTML(value.workingDirectory ?? '')}" placeholder="Inherit"></label>
        </div>
        <label>Flow system instructions<textarea data-default-prompt rows="4" placeholder="每行一段 system 消息">${escapeHTML((value.systemPrompt ?? []).join('\n'))}</textarea></label>
        ${multiSelect('default-tools', 'Tools', value.toolIds, options.tools ?? [])}
        ${multiSelect('default-skills', 'Skills', value.skillIds, options.skills ?? [])}
    </fieldset>`;
}

function entitySelect(name: string, selected: string | undefined, values: EntityOption[], empty: string): string {
    const options = selected && !values.some(item => item.id === selected)
        ? [{ id: selected, name: `${selected} (unavailable)` }, ...values]
        : values;
    return selectControl(name, selected, options.map(item => ({ value: item.id, label: item.name })), empty);
}

function slotSelect(connections: FlowConnection[], selected?: string): string {
    const values = selected && !connections.some(item => item.name === selected)
        ? [{ name: selected, connectionId: '' }, ...connections]
        : connections;
    return selectControl('default-connection', selected, values.map(item => ({ value: item.name, label: item.name })), 'Use default slot');
}

function optionSelect(name: string, selected: string | undefined, values: string[]): string {
    return selectControl(name, selected, values.map(value => ({ value, label: value })), 'Inherit');
}

function triStateSelect(name: string, selected: boolean | undefined): string {
    return selectControl(name, selected === undefined ? undefined : String(selected), [
        { value: 'true', label: 'On' }, { value: 'false', label: 'Off' },
    ], 'Inherit');
}

function selectControl(
    dataName: string,
    selected: string | undefined,
    options: Array<{ value: string; label: string }>,
    emptyLabel: string,
): string {
    const option = (value: string, label: string) =>
        `<option value="${escapeHTML(value)}" ${value === (selected ?? '') ? 'selected' : ''}>${escapeHTML(label)}</option>`;
    return `<select data-${dataName}>${option('', emptyLabel)}${options.map(item => option(item.value, item.label)).join('')}</select>`;
}

function multiSelect(name: string, label: string, selected: string[] | undefined, values: EntityOption[]): string {
    const chosen = new Set(selected ?? []);
    const missing = [...chosen].filter(id => !values.some(item => item.id === id)).map(id => ({ id, name: `${id} (unavailable)` }));
    const options = [...missing, ...values];
    return `<label>${label}<select data-${name} multiple size="${Math.min(6, Math.max(3, options.length))}">${options.map(item =>
        `<option value="${escapeHTML(item.id)}" ${chosen.has(item.id) ? 'selected' : ''}>${escapeHTML(item.name)}</option>`,
    ).join('')}</select><small>按 Ctrl/Cmd 可多选；节点可继续追加。</small></label>`;
}

function connectionRow(
    connection: FlowConnection,
    available: Array<{ id: string; name: string }>,
    defaultConnection: string | undefined,
): string {
    const isDefault = connection.name === defaultConnection || (!defaultConnection && connection.name === 'default');
    return `<div class="dag-setting-row" data-conn-row>
        <label class="dag-settings__default" title="Default"><input type="radio" name="dag-default-conn" ${isDefault ? 'checked' : ''}>default</label>
        <input data-conn-name placeholder="name" value="${escapeHTML(connection.name)}">
        <select data-conn-id>${available.map(item =>
            `<option value="${escapeHTML(item.id)}" ${item.id === connection.connectionId ? 'selected' : ''}>${escapeHTML(item.name)}</option>`,
        ).join('')}</select>
        <input data-conn-desc placeholder="description" value="${escapeHTML(connection.description ?? '')}">
        <button type="button" data-remove-conn>×</button>
    </div>`;
}

function parameterRow(parameter?: FlowParameter): string {
    const param = parameter ?? { name: '', type: 'string' as const };
    const value = param.default !== undefined ? stringifyDefault(param.default, param.type) : '';
    return `<div class="dag-setting-row" data-param-row>
        <input data-param-name placeholder="name" value="${escapeHTML(param.name)}">
        <select data-param-type>${PARAM_TYPES.map(type =>
            `<option ${type === param.type ? 'selected' : ''}>${type}</option>`,
        ).join('')}</select>
        <input data-param-default placeholder="default" value="${escapeHTML(value)}">
        <label class="dag-settings__check" title="Required"><input type="checkbox" data-param-required ${param.required ? 'checked' : ''}>required</label>
        <input data-param-desc placeholder="description" value="${escapeHTML(param.description ?? '')}">
        ${parameterConstraints(param)}
        <button type="button" data-remove-param>×</button>
    </div>`;
}

function parameterConstraints(param: FlowParameter): string {
    return `<label>${escapeHTML(t('flow.parameters.minimum'))}<input type="number" step="any" data-param-min value="${escapeHTML(String(param.minimum ?? ''))}"></label>
        <label>${escapeHTML(t('flow.parameters.maximum'))}<input type="number" step="any" data-param-max value="${escapeHTML(String(param.maximum ?? ''))}"></label>
        <label><input type="checkbox" data-param-integer ${param.integer ? 'checked' : ''}>${escapeHTML(t('flow.parameters.integer'))}</label>
        <label>${escapeHTML(t('flow.parameters.onMissing'))}<select data-param-missing>
            <option value="error">${escapeHTML(t('flow.parameters.reject'))}</option>
            <option value="interact" ${param.onMissing === 'interact' ? 'selected' : ''}>${escapeHTML(t('flow.parameters.interact'))}</option>
        </select></label>`;
}

function readParameterConstraints(row: HTMLElement, type: FlowParameter['type']): Partial<FlowParameter> {
    const result: Partial<FlowParameter> = {};
    if (readInput(row, '[data-param-missing]') === 'interact') result.onMissing = 'interact';
    if (type !== 'number') return result;
    for (const [key, selector] of [['minimum', '[data-param-min]'], ['maximum', '[data-param-max]']] as const) {
        const raw = readInput(row, selector).trim();
        if (raw) result[key] = Number(raw);
    }
    if (row.querySelector<HTMLInputElement>('[data-param-integer]')?.checked) result.integer = true;
    if ((result.minimum !== undefined && !Number.isFinite(result.minimum)) || (result.maximum !== undefined && !Number.isFinite(result.maximum))
        || (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum)) throw new Error(t('flow.launch.invalidValue'));
    return result;
}

function bindRowControls(dialog: HTMLDialogElement, options: FlowSettingsOptions): void {
    dialog.querySelector('[data-add-connection]')?.addEventListener('click', () => {
        const container = dialog.querySelector<HTMLElement>('[data-connections]')!;
        container.insertAdjacentHTML('beforeend', connectionRow(
            { name: '', connectionId: options.availableConnections[0]?.id ?? 'default' },
            options.availableConnections,
            options.defaultConnection,
        ));
    });
    dialog.querySelector('[data-add-parameter]')?.addEventListener('click', () => {
        const container = dialog.querySelector<HTMLElement>('[data-parameters]')!;
        container.insertAdjacentHTML('beforeend', parameterRow());
    });
    dialog.addEventListener('click', event => {
        const target = event.target as HTMLElement;
        if (target.closest('[data-remove-conn]')) {
            target.closest('[data-conn-row]')?.remove();
        } else if (target.closest('[data-remove-param]')) {
            target.closest('[data-param-row]')?.remove();
        }
    });
}

function readSettings(dialog: HTMLDialogElement): FlowSettingsResult {
    const connections = [...dialog.querySelectorAll<HTMLElement>('[data-conn-row]')].map(row => {
        const name = readInput(row, '[data-conn-name]').trim();
        const connectionId = readInput(row, '[data-conn-id]');
        const description = readInput(row, '[data-conn-desc]').trim();
        if (!name) throw new Error('Every connection needs a name');
        if (!connectionId) throw new Error(`Connection ${name} needs a global connection`);
        return { name, connectionId, ...(description ? { description } : {}) };
    });
    if (new Set(connections.map(item => item.name)).size !== connections.length) {
        throw new Error('Connection names must be unique');
    }
    const defaultRow = [...dialog.querySelectorAll<HTMLElement>('[data-conn-row]')]
        .find(row => row.querySelector<HTMLInputElement>('[data-conn-default], input[type="radio"]')?.checked);
    const defaultConnection = defaultRow
        ? readInput(defaultRow, '[data-conn-name]').trim()
        : connections[0]?.name;

    const parameters = [...dialog.querySelectorAll<HTMLElement>('[data-param-row]')].map(row => {
        const name = readInput(row, '[data-param-name]').trim();
        const type = readInput(row, '[data-param-type]') as FlowParameter['type'];
        const required = row.querySelector<HTMLInputElement>('[data-param-required]')?.checked ?? false;
        const description = readInput(row, '[data-param-desc]').trim();
        if (!name) throw new Error('Every parameter needs a name');
        const raw = readInput(row, '[data-param-default]');
        const result: FlowParameter = { name, type, ...readParameterConstraints(row, type), ...(description ? { description } : {}) };
        if (required) result.required = true;
        if (raw !== '') result.default = parseDefault(raw, type);
        return result;
    });
    if (new Set(parameters.map(item => item.name)).size !== parameters.length) {
        throw new Error('Parameter names must be unique');
    }
    const defaults = readDefaults(dialog);
    const runPolicy = readRunPolicy(dialog);
    const variables = JSON.parse(dialog.querySelector<HTMLTextAreaElement>('[data-variables]')!.value);
    if (!variables || Array.isArray(variables) || typeof variables !== 'object') throw new Error(t('flow.variables.invalid'));
    const outputs = JSON.parse(dialog.querySelector<HTMLTextAreaElement>('[data-outputs]')!.value);
    if (!outputs || Array.isArray(outputs) || typeof outputs !== 'object') throw new Error(t('flow.launch.invalidValue'));
    return { connections, defaultConnection, parameters, variables, defaults, runPolicy, outputs };
}

function readRunPolicy(dialog: HTMLDialogElement): FlowRunPolicy {
    const value = (selector: string) => dialog.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value.trim() ?? '';
    const number = (selector: string) => { const raw = value(selector); return raw ? Number(raw) : undefined; };
    const policy: FlowRunPolicy = {};
    const maxNodes = number('[data-run-max-nodes]'); if (maxNodes !== undefined) policy.maxNodes = maxNodes;
    const maxConcurrency = number('[data-run-max-concurrency]'); if (maxConcurrency !== undefined) policy.maxConcurrency = maxConcurrency;
    const timeoutMs = number('[data-run-timeout]'); if (timeoutMs !== undefined) policy.timeoutMs = timeoutMs;
    const maxTokens = number('[data-run-max-tokens]'); if (maxTokens !== undefined) policy.maxTokens = maxTokens;
    const mode = value('[data-run-workspace-mode]') as 'shared' | 'read-only' | 'worktree' | '';
    const merge = value('[data-run-workspace-merge]') as 'manual' | 'auto-if-clean' | 'discard' | '';
    const cleanup = value('[data-run-workspace-cleanup]') as 'on-success' | 'always' | 'keep' | '';
    const base = value('[data-run-workspace-base]');
    if (mode || merge || cleanup || base) policy.workspace = {
        ...(mode ? { mode } : { mode: 'shared' }), ...(merge ? { merge } : {}), ...(cleanup ? { cleanup } : {}), ...(base ? { base } : {}),
    };
    return policy;
}

function readDefaults(dialog: HTMLDialogElement): FlowDefaults {
    const value = (selector: string) => dialog.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector)?.value.trim() ?? '';
    const number = (selector: string) => { const raw = value(selector); return raw === '' ? undefined : Number(raw); };
    const selected = (selector: string) => [...(dialog.querySelector<HTMLSelectElement>(selector)?.selectedOptions ?? [])].map(option => option.value);
    const thinking = value('[data-default-thinking]');
    const stream = value('[data-default-stream]');
    const webSearch = value('[data-default-web-search]');
    const persistOutput = value('[data-default-persist-output]');
    const prompt = value('[data-default-prompt]').split('\n').map(line => line.trim()).filter(Boolean);
    const result: FlowDefaults = {};
    const strings: Array<[keyof FlowDefaults, string]> = [
        ['agentId', value('[data-default-agent]')], ['systemPromptId', value('[data-default-system-prompt]')],
        ['connectionId', value('[data-default-connection]')], ['modelName', value('[data-default-model]')],
        ['reasoningEffort', value('[data-default-reasoning]')], ['approval', value('[data-default-approval]')],
        ['historyPolicy', value('[data-default-history]')], ['systemPromptPolicy', value('[data-default-system-policy]')],
        ['workingDirectory', value('[data-default-working-directory]')],
    ];
    for (const [key, item] of strings) if (item) (result as Record<string, unknown>)[key] = item;
    const temperature = number('[data-default-temperature]'); if (temperature !== undefined) result.temperature = temperature;
    const maxTokens = number('[data-default-max-tokens]'); if (maxTokens !== undefined) result.maxTokens = maxTokens;
    const maxExchanges = number('[data-default-max-exchanges]'); if (maxExchanges !== undefined) result.maxExchanges = maxExchanges;
    const timeoutMs = number('[data-default-timeout]'); if (timeoutMs !== undefined) result.timeoutMs = timeoutMs;
    if (thinking) result.thinking = thinking === 'true';
    if (stream) result.stream = stream === 'true';
    if (webSearch) result.webSearch = webSearch === 'true';
    if (persistOutput) result.persistOutput = persistOutput === 'true';
    if (prompt.length) result.systemPrompt = prompt;
    const toolIds = selected('[data-default-tools]'); if (toolIds.length) result.toolIds = toolIds;
    const skillIds = selected('[data-default-skills]'); if (skillIds.length) result.skillIds = skillIds;
    return result;
}

function readInput(row: HTMLElement, selector: string): string {
    const element = row.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
    return element?.value ?? '';
}

function stringifyDefault(value: JsonValue, type: FlowParameter['type']): string {
    if (type === 'json') return JSON.stringify(value);
    if (type === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

function parseDefault(raw: string, type: FlowParameter['type']): JsonValue {
    if (type === 'number') {
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new Error(`Default for a number parameter must be numeric`);
        return value;
    }
    if (type === 'boolean') return raw === 'true';
    if (type === 'json') return JSON.parse(raw) as JsonValue;
    return raw;
}

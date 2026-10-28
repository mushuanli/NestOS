// @file: llm-ui/components/dag/FlowSettingsDialog.ts
// Flow-level settings modal: named connection slots (bound to global LLM
// connections + one default) and declared runtime parameters with defaults.

import type { FlowConnection, FlowVariables, FlowDefaults, FlowParameter, FlowRunPolicy, JsonValue } from '@itookit/llm-flow/contracts';
import { validImageConstraints, validFileConstraints } from '@itookit/llm-flow/contracts';
import { escapeHTML, t } from '@itookit/common';

export interface FlowSettingsOptions {
    exposure?: import('@itookit/llm-flow/contracts').CallableExposure;
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

export interface EntityOption { id: string; name: string; description?: string; parameters?: Record<string, unknown>; version?: string }

export interface FlowSettingsResult {
    exposure?: import('@itookit/llm-flow/contracts').CallableExposure;
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
        dialog.setAttribute('aria-labelledby', 'dag-settings-title');
        dialog.innerHTML = settingsTemplate(options);
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
                const feedback = dialog.querySelector<HTMLElement>('[data-dialog-error]')!;
                feedback.textContent = error instanceof Error ? error.message : t('flow.settings.invalid');
                dialog.showModal();
                feedback.focus();
            }
        });
    });
}

function settingsTemplate(options: FlowSettingsOptions): string {
    return `<form method="dialog">
        <header class="dag-settings__header"><h2 id="dag-settings-title" tabindex="-1" autofocus>${text('flow.settings.title')}</h2>
            <p>${text('flow.settings.description')}</p></header>
        <div class="dag-settings__body">
            ${exposureSection(options.exposure)}
            ${connectionsSection(options)}${parametersSection(options.parameters)}${defaultsSection(options)}
            ${runPolicySection(options.runPolicy)}${variablesSection(options)}
        </div>
        <footer class="dag-settings__footer"><p data-dialog-error class="dag-dialog__error" role="alert" tabindex="-1"></p>
            <menu><button value="cancel">${text('flow.settings.cancel')}</button>
                <button value="save" class="dag-settings__save">${text('flow.settings.save')}</button></menu>
        </footer>
    </form>`;
}

function exposureSection(exposure: FlowSettingsOptions['exposure']): string {
    return `<fieldset><legend>${text('callable.exposure.label')}</legend>
        <select data-exposure aria-label="${text('callable.exposure.label')}">
            ${exposure !== undefined && !['global', 'local'].includes(exposure) ? `<option value="" selected>${text('callable.exposure.invalid')}</option>` : ''}
            <option value="global" ${exposure === undefined || exposure === 'global' ? 'selected' : ''}>${text('callable.exposure.global')}</option>
            <option value="local" ${exposure === 'local' ? 'selected' : ''}>${text('callable.exposure.local')}</option>
        </select><p class="dag-settings__hint">${text('callable.exposure.hint')}</p></fieldset>`;
}

function connectionsSection(options: FlowSettingsOptions): string {
    return `<fieldset><legend>${text('flow.settings.connections')}</legend>
        <p class="dag-settings__hint">${text('flow.settings.connectionsHint')}</p>
        <div data-connections class="dag-settings__list">
            <p class="dag-settings__empty">${text('flow.settings.noConnections')}</p>
            ${options.connections.map(connection => connectionRow(connection, options.availableConnections, options.defaultConnection)).join('')}
        </div>
        <button type="button" data-add-connection class="dag-settings__add">${text('flow.settings.addConnection')}</button>
    </fieldset>`;
}

function parametersSection(parameters: FlowParameter[]): string {
    return `<fieldset><legend>${text('flow.parameters.title')}</legend>
        <p class="dag-settings__hint">${text('flow.settings.parametersHint')}</p>
        <div data-parameters class="dag-settings__list"><p class="dag-settings__empty">${text('flow.settings.noParameters')}</p>
            ${parameters.map(parameterRow).join('')}</div>
        <button type="button" data-add-parameter class="dag-settings__add">${text('flow.settings.addParameter')}</button>
    </fieldset>`;
}

function variablesSection(options: FlowSettingsOptions): string {
    return disclosure('flow.settings.variablesOutputs', `<div class="dag-settings__stack">
        <p class="dag-settings__hint">${text('flow.variables.hint')}</p>
        ${field('flow.variables.title', `<textarea class="dag-settings__code" data-variables rows="6">${escapeHTML(JSON.stringify(options.variables ?? {}, null, 2))}</textarea>`)}
        ${field('flow.invoke.outputs', `<textarea class="dag-settings__code" data-outputs rows="5">${escapeHTML(JSON.stringify(options.outputs ?? {}, null, 2))}</textarea>`)}
    </div>`);
}

function runPolicySection(policy: FlowRunPolicy = {}): string {
    const workspace: Partial<NonNullable<FlowRunPolicy['workspace']>> = policy.workspace ?? {};
    return disclosure('flow.settings.runPolicy', `<p class="dag-settings__hint">${text('flow.settings.runPolicyHint')}</p>
        <h3 class="dag-settings__group-title">${text('flow.settings.runLimits')}</h3>
        <div class="dag-settings__grid">
            ${field('flow.settings.maxNodes', `<input data-run-max-nodes type="number" min="1" value="${policy.maxNodes ?? ''}" placeholder="1000">`)}
            ${field('flow.settings.maxConcurrency', policyInput('run-max-concurrency', policy.maxConcurrency))}
            ${field('flow.settings.runTimeout', policyInput('run-timeout', policy.timeoutMs))}
            ${field('flow.settings.tokenBudget', policyInput('run-max-tokens', policy.maxTokens))}
        </div>
        <h3 class="dag-settings__group-title">${text('flow.settings.workspace')}</h3>
        <div class="dag-settings__grid">
            ${field('flow.settings.workspaceMode', optionSelect('run-workspace-mode', workspace.mode, ['shared', 'read-only', 'worktree']))}
            ${field('flow.settings.mergePolicy', optionSelect('run-workspace-merge', workspace.merge, ['manual', 'auto-if-clean', 'discard']))}
            ${field('flow.settings.cleanup', optionSelect('run-workspace-cleanup', workspace.cleanup, ['on-success', 'always', 'keep']))}
            ${field('flow.settings.baseRevision', `<input data-run-workspace-base value="${escapeHTML(workspace.base ?? '')}" placeholder="current / head / revision">`)}
        </div>`);
}

function policyInput(name: string, value?: number): string {
    return `<input data-${name} type="number" min="1" value="${value ?? ''}" placeholder="${text('flow.settings.runtimeDefault')}">`;
}

function defaultsSection(options: FlowSettingsOptions): string {
    const value = options.defaults ?? {};
    return `<fieldset><legend>${text('flow.settings.defaults')}</legend>
        <p class="dag-settings__hint">${text('flow.settings.defaultsHint')}</p>
        <div class="dag-settings__grid">
            ${field('flow.settings.agent', entitySelect('default-agent', value.agentId, options.agents ?? [], t('flow.settings.inheritAgent')))}
            ${field('flow.settings.systemPrompt', entitySelect('default-system-prompt', value.systemPromptId, options.systemPrompts ?? [], t('flow.settings.inheritPrompt')))}
            ${field('flow.settings.connectionSlot', slotSelect(options.connections, value.connectionId))}
            ${field('flow.settings.model', `<input data-default-model value="${escapeHTML(value.modelName ?? '')}" placeholder="${text('flow.settings.inheritModel')}">`)}
        </div>
        ${field('flow.settings.instructions', `<textarea data-default-prompt rows="4" placeholder="${text('flow.settings.instructionsHint')}">${escapeHTML((value.systemPrompt ?? []).join('\n'))}</textarea>`)}
        ${disclosure('flow.settings.advancedDefaults', `${modelDefaults(value)}${executionDefaults(value)}
            <h3 class="dag-settings__group-title">${text('flow.settings.capabilities')}</h3>
            <div class="dag-settings__grid">${multiSelect('default-tools', t('flow.settings.tools'), value.toolIds, options.tools ?? [])}
                ${multiSelect('default-skills', t('flow.settings.skills'), value.skillIds, options.skills ?? [])}</div>`)}
    </fieldset>`;
}

function modelDefaults(value: FlowDefaults): string {
    return `<h3 class="dag-settings__group-title">${text('flow.settings.modelBehavior')}</h3><div class="dag-settings__grid">
        ${field('flow.settings.temperature', `<input data-default-temperature type="number" step="0.1" min="0" max="2" value="${value.temperature ?? ''}" placeholder="${text('flow.settings.inherit')}">`)}
        ${field('flow.settings.maxTokens', `<input data-default-max-tokens type="number" min="1" value="${value.maxTokens ?? ''}" placeholder="${text('flow.settings.inherit')}">`)}
        ${field('flow.settings.thinking', triStateSelect('default-thinking', value.thinking))}
        ${field('flow.settings.reasoning', `<input data-default-reasoning value="${escapeHTML(value.reasoningEffort ?? '')}" placeholder="${text('provider.reasoning.default')}">`)}
        ${field('flow.settings.streaming', triStateSelect('default-stream', value.stream))}
        ${field('flow.settings.webSearch', triStateSelect('default-web-search', value.webSearch))}
    </div>`;
}

function executionDefaults(value: FlowDefaults): string {
    return `<h3 class="dag-settings__group-title">${text('flow.settings.executionBehavior')}</h3><div class="dag-settings__grid">
        ${field('flow.settings.approval', optionSelect('default-approval', value.approval, ['none', 'external', 'all']))}
        ${field('flow.settings.history', optionSelect('default-history', value.historyPolicy, ['inherit', 'upstream', 'none']))}
        ${field('flow.settings.systemPromptPolicy', optionSelect('default-system-policy', value.systemPromptPolicy, ['inherit', 'replace', 'none']))}
        ${field('flow.settings.persistOutput', triStateSelect('default-persist-output', value.persistOutput))}
        ${field('flow.settings.maxExchanges', `<input data-default-max-exchanges type="number" min="1" value="${value.maxExchanges ?? ''}" placeholder="${text('flow.settings.inherit')}">`)}
        ${field('flow.settings.timeout', `<input data-default-timeout type="number" min="1000" value="${value.timeoutMs ?? ''}" placeholder="${text('flow.settings.inherit')}">`)}
        ${field('flow.settings.workingDirectory', `<input data-default-working-directory value="${escapeHTML(value.workingDirectory ?? '')}" placeholder="${text('flow.settings.inherit')}">`)}
    </div>`;
}

function text(key: Parameters<typeof t>[0]): string { return escapeHTML(t(key)); }

function field(key: Parameters<typeof t>[0], control: string): string {
    return `<label class="dag-settings__field"><span>${text(key)}</span>${control}</label>`;
}

function disclosure(key: Parameters<typeof t>[0], content: string): string {
    return `<details class="dag-settings__disclosure"><summary>${text(key)}</summary><div class="dag-settings__disclosure-body">${content}</div></details>`;
}

function entitySelect(name: string, selected: string | undefined, values: EntityOption[], empty: string): string {
    const options = selected && !values.some(item => item.id === selected)
        ? [{ id: selected, name: t('flow.settings.unavailable', { id: selected }) }, ...values]
        : values;
    return selectControl(name, selected, options.map(item => ({ value: item.id, label: item.name })), empty);
}

function slotSelect(connections: FlowConnection[], selected?: string): string {
    const values = selected && !connections.some(item => item.name === selected)
        ? [{ name: selected, connectionId: '' }, ...connections]
        : connections;
    return selectControl('default-connection', selected, values.map(item => ({ value: item.name, label: item.name })), t('flow.settings.useDefaultSlot'));
}

const OPTION_LABELS: Record<string, Parameters<typeof t>[0]> = {
    shared: 'flow.settings.option.shared', 'read-only': 'flow.settings.option.readOnly', worktree: 'flow.settings.option.worktree',
    manual: 'flow.settings.option.manual', 'auto-if-clean': 'flow.settings.option.autoIfClean', discard: 'flow.settings.option.discard',
    'on-success': 'flow.settings.option.onSuccess', always: 'flow.settings.option.always', keep: 'flow.settings.option.keep',
    none: 'flow.settings.option.none', external: 'flow.settings.option.external', all: 'flow.settings.option.all',
    inherit: 'flow.settings.option.inherit', upstream: 'flow.settings.option.upstream', replace: 'flow.settings.option.replace',
    optimal: 'flow.settings.option.optimal', standard: 'flow.settings.option.standard', fast: 'flow.settings.option.fast',
    string: 'flow.settings.option.string', number: 'flow.settings.option.number', boolean: 'flow.settings.option.boolean', json: 'flow.settings.option.json',
};

function optionSelect(name: string, selected: string | undefined, values: string[]): string {
    return selectControl(name, selected, values.map(value => ({ value, label: OPTION_LABELS[value] ? t(OPTION_LABELS[value]) : value })), t('flow.settings.inherit'));
}

function triStateSelect(name: string, selected: boolean | undefined): string {
    return selectControl(name, selected === undefined ? undefined : String(selected), [
        { value: 'true', label: t('flow.settings.on') }, { value: 'false', label: t('flow.settings.off') },
    ], t('flow.settings.inherit'));
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
    const missing = [...chosen].filter(id => !values.some(item => item.id === id)).map(id => ({ id, name: t('flow.settings.unavailable', { id }) }));
    const options = [...missing, ...values];
    return `<label class="dag-settings__field"><span>${escapeHTML(label)}</span><select data-${name} multiple size="${Math.min(6, Math.max(3, options.length))}">${options.map(item =>
        `<option value="${escapeHTML(item.id)}" ${chosen.has(item.id) ? 'selected' : ''}>${escapeHTML(item.name)}</option>`,
    ).join('')}</select><small>${text('flow.settings.multiSelectHint')}</small></label>`;
}

function connectionRow(
    connection: FlowConnection,
    available: Array<{ id: string; name: string }>,
    defaultConnection: string | undefined,
): string {
    const isDefault = connection.name === defaultConnection || (!defaultConnection && connection.name === 'default');
    const missing = connection.connectionId && !available.some(item => item.id === connection.connectionId)
        ? `<option value="${escapeHTML(connection.connectionId)}" selected>${escapeHTML(t('connection.unavailable', { id: connection.connectionId }))}</option>` : '';
    return `<div class="dag-setting-row" data-conn-row data-conn-original="${escapeHTML(JSON.stringify(connection))}">
        <div class="dag-settings__row-actions"><label class="dag-settings__check"><input type="radio" name="dag-default-conn" ${isDefault ? 'checked' : ''}>${text('flow.settings.defaultConnection')}</label>
            <label class="dag-settings__check"><input type="checkbox" data-conn-required ${connection.required === false ? '' : 'checked'}>${text('flow.connections.required')}</label>
            <button type="button" data-remove-conn>${text('flow.settings.remove')}</button></div>
        <div class="dag-settings__grid">
            ${field('flow.settings.slotName', `<input data-conn-name placeholder="analysis" value="${escapeHTML(connection.name)}">`)}
            ${field('flow.settings.boundConnection', `<select data-conn-id><option value="">${text('connection.slotUnbound')}</option>${missing}${available.map(item =>
                `<option value="${escapeHTML(item.id)}" ${item.id === connection.connectionId ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}</select>`)}
        </div>
        ${field('flow.settings.connectionDescription', `<input data-conn-desc placeholder="${text('flow.settings.connectionDescriptionHint')}" value="${escapeHTML(connection.description ?? '')}">`)}
        ${disclosure('flow.settings.connectionAdvanced', `<div class="dag-settings__grid">
            ${field('flow.connections.tier', `<select data-conn-tier>${['optimal', 'standard', 'fast'].map(tier => `<option value="${tier}" ${tier === (connection.tier ?? 'optimal') ? 'selected' : ''}>${text(OPTION_LABELS[tier])}</option>`).join('')}</select>`)}
            </div>${field('flow.connections.requirements', `<textarea class="dag-settings__code" data-conn-requirements rows="3">${escapeHTML(JSON.stringify(connection.requirements ?? {}, null, 2))}</textarea>`)}`)}
    </div>`;
}

function parameterRow(parameter?: FlowParameter): string {
    const param = parameter ?? { name: '', type: 'string' as const };
    const value = param.default !== undefined ? stringifyDefault(param.default, param.type) : '';
    return `<div class="dag-setting-row" data-param-row data-param-original="${escapeHTML(JSON.stringify(param))}">
        <div class="dag-settings__row-actions"><label class="dag-settings__check"><input type="checkbox" data-param-required ${param.required ? 'checked' : ''}>${text('flow.settings.requiredParameter')}</label>
            <button type="button" data-remove-param>${text('flow.settings.remove')}</button></div>
        <div class="dag-settings__grid">
            ${field('flow.settings.parameterName', `<input data-param-name placeholder="prompt" value="${escapeHTML(param.name)}">`)}
            ${field('flow.settings.parameterType', `<select data-param-type>${PARAM_TYPES.map(type => `<option value="${type}" ${type === param.type ? 'selected' : ''}>${text(OPTION_LABELS[type])}</option>`).join('')}</select>`)}
            ${field('flow.settings.parameterDefault', `<input data-param-default placeholder="${text('flow.settings.noDefault')}" value="${escapeHTML(value)}">`)}
            ${field('flow.settings.parameterDescription', `<input data-param-desc value="${escapeHTML(param.description ?? '')}">`)}
        </div>
        ${parameterPresentation(param)}
        ${disclosure('flow.settings.parameterValidation', parameterConstraints(param))}
    </div>`;
}

function parameterPresentation(param: FlowParameter): string {
    const widgets = ['', 'text', 'textarea', 'number', 'select', 'checkbox', 'images', 'files'] as const;
    const sources = ['', 'composer.text', 'composer.attachments'] as const;
    return `<div class="dag-settings__grid">
        ${field('flow.parameters.role', `<select data-param-role>${(['', 'input', 'option', 'policy'] as const).map(role => `<option value="${role}" ${role === (param.role ?? '') ? 'selected' : ''}>${text(`flow.parameters.role.${role || 'legacy'}`)}</option>`).join('')}</select>`)}
        ${field('flow.editor.widget', `<select data-param-widget>${widgets.map(widget => `<option value="${widget}" ${widget === (param.widget ?? '') ? 'selected' : ''}>${text(`flow.parameters.widget.${widget || 'auto'}`)}</option>`).join('')}</select>`)}
        ${field('flow.source.label', `<select data-param-source>${sources.map(source => `<option value="${source}" ${source === (param.inputSource ?? '') ? 'selected' : ''}>${text(source === 'composer.text' ? 'flow.parameters.source.text' : source === 'composer.attachments' ? 'flow.parameters.source.attachments' : 'flow.source.custom')}</option>`).join('')}</select>`)}
    </div>`;
}

function parameterConstraints(param: FlowParameter): string {
    return `<div class="dag-settings__grid" data-param-number-fields ${param.type !== 'number' ? 'hidden' : ''}>
        ${field('flow.parameters.minimum', `<input type="number" step="any" data-param-min value="${escapeHTML(String(param.minimum ?? ''))}">`)}
        ${field('flow.parameters.maximum', `<input type="number" step="any" data-param-max value="${escapeHTML(String(param.maximum ?? ''))}">`)}
        <label class="dag-settings__check"><input type="checkbox" data-param-integer ${param.integer ? 'checked' : ''}>${text('flow.parameters.integer')}</label>
        </div>
        ${field('flow.parameters.onMissing', `<select data-param-missing>
            <option value="error">${text('flow.parameters.reject')}</option>
            <option value="interact" ${param.onMissing === 'interact' ? 'selected' : ''}>${text('flow.parameters.interact')}</option>
        </select>`)}
        <div data-param-image-fields ${param.widget !== 'images' ? 'hidden' : ''}>${field('flow.parameters.imageConstraints', `<input class="dag-settings__code" data-param-images value="${escapeHTML(JSON.stringify(param.imageConstraints ?? {}))}">`)}</div>
        <div data-param-file-fields ${param.widget !== 'files' ? 'hidden' : ''}>${field('flow.parameters.fileConstraints', `<input class="dag-settings__code" data-param-files value="${escapeHTML(JSON.stringify(param.fileConstraints ?? {}))}">`)}</div>`;
}

function readParameterConstraints(row: HTMLElement, type: FlowParameter['type']): Partial<FlowParameter> {
    const result = readMaterialConstraints(row, type);
    if (readInput(row, '[data-param-missing]') === 'interact') result.onMissing = 'interact';
    return type === 'number' ? {...result, ...readNumberConstraints(row)} : result;
}
function readMaterialConstraints(row: HTMLElement, type: FlowParameter['type']): Partial<FlowParameter> {
    const result: Partial<FlowParameter> = {};
    if (type !== 'json') return result;
    const widget = readInput(row, '[data-param-widget]');
    if (widget === 'images') {
        result.imageConstraints = JSON.parse(readInput(row, '[data-param-images]') || '{}');
        if (!validImageConstraints(result.imageConstraints)) throw new Error(t('flow.launch.invalidValue'));
    }
    if (widget === 'files') {
        result.fileConstraints = JSON.parse(readInput(row, '[data-param-files]') || '{}');
        if (!validFileConstraints(result.fileConstraints)) throw new Error(t('flow.launch.invalidValue'));
    }
    return result;
}
function readNumberConstraints(row: HTMLElement): Partial<FlowParameter> {
    const result: Partial<FlowParameter> = {};
    for (const [key, selector] of [['minimum', '[data-param-min]'], ['maximum', '[data-param-max]']] as const) {
        const raw = readInput(row, selector).trim();
        if (raw) result[key] = Number(raw);
    }
    if (row.querySelector<HTMLInputElement>('[data-param-integer]')?.checked) result.integer = true;
    if (!validNumericBounds(result)) throw new Error(t('flow.launch.invalidValue'));
    return result;
}
function validNumericBounds({minimum, maximum}: Partial<FlowParameter>): boolean {
    return [minimum, maximum].every(value => value === undefined || Number.isFinite(value))
        && !(minimum !== undefined && maximum !== undefined && minimum > maximum);
}

function bindRowControls(dialog: HTMLDialogElement, options: FlowSettingsOptions): void {
    dialog.addEventListener('change', updateParameterControls);
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

function updateParameterControls(event: Event): void {
    const target = event.target as HTMLSelectElement;
    if (!target.matches('[data-param-type], [data-param-widget]')) return;
    const row = target.closest<HTMLElement>('[data-param-row]');
    if (!row) return;
    const widget = readInput(row, '[data-param-widget]');
    row.querySelector<HTMLElement>('[data-param-image-fields]')!.hidden = widget !== 'images';
    row.querySelector<HTMLElement>('[data-param-file-fields]')!.hidden = widget !== 'files';
    row.querySelector<HTMLElement>('[data-param-number-fields]')!.hidden = readInput(row, '[data-param-type]') !== 'number';
}

function readConnectionRow(row: HTMLElement): FlowConnection {
    const name = readInput(row, '[data-conn-name]').trim();
    const connectionId = readInput(row, '[data-conn-id]');
    const description = readInput(row, '[data-conn-desc]').trim();
    if (!name) throw new Error(t('flow.settings.connectionNameRequired'));
    const original = JSON.parse(row.dataset.connOriginal ?? '{}') as FlowConnection;
    const requirements = JSON.parse(readInput(row, '[data-conn-requirements]') || '{}');
    if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)
        || Object.keys(requirements).length && (typeof requirements.operation !== 'string' || !requirements.operation.trim())) throw new Error(t('flow.settings.connectionOperationRequired'));
    for (const key of ['inputModalities', 'outputModalities', 'features', 'responseFormats']) if (requirements[key] !== undefined
        && (!Array.isArray(requirements[key]) || requirements[key].some((item: unknown) => typeof item !== 'string' || !item.trim()))) throw new Error(t('flow.settings.invalidRequirement', { key }));
    if (requirements.responseFormats?.some((format: string) => !['text', 'json_object', 'json_schema'].includes(format)))
        throw new Error(t('flow.settings.invalidRequirement', {key: 'responseFormats'}));
    const required = row.querySelector<HTMLInputElement>('[data-conn-required]')!.checked;
    const tier = readInput(row, '[data-conn-tier]') as FlowConnection['tier'];
    const changed = connectionId !== (original.connectionId ?? '') || required !== (original.required !== false)
        || tier !== (original.tier ?? 'optimal') || JSON.stringify(requirements) !== JSON.stringify(original.requirements ?? {});
    return { ...original, name, connectionId: connectionId || undefined, description: description || undefined, required, tier,
        requirements: Object.keys(requirements).length ? requirements : undefined,
        ...(changed ? {resolved: undefined} : {}) };
}

function readSettings(dialog: HTMLDialogElement): FlowSettingsResult {
    const connections = [...dialog.querySelectorAll<HTMLElement>('[data-conn-row]')].map(readConnectionRow);
    if (new Set(connections.map(item => item.name)).size !== connections.length) {
        throw new Error(t('flow.settings.connectionNamesUnique'));
    }
    const defaultRow = [...dialog.querySelectorAll<HTMLElement>('[data-conn-row]')]
        .find(row => row.querySelector<HTMLInputElement>('[data-conn-default], input[type="radio"]')?.checked);
    const defaultConnection = defaultRow
        ? readInput(defaultRow, '[data-conn-name]').trim()
        : connections[0]?.name;

    const parameters = [...dialog.querySelectorAll<HTMLElement>('[data-param-row]')].map(readParameterRow);
    if (new Set(parameters.map(item => item.name)).size !== parameters.length) {
        throw new Error(t('flow.settings.parameterNamesUnique'));
    }
    const defaults = readDefaults(dialog);
    const runPolicy = readRunPolicy(dialog);
    const variables = readObject<FlowVariables>(dialog, '[data-variables]', 'flow.variables.invalid');
    const outputs = readObject<NonNullable<FlowSettingsResult['outputs']>>(dialog, '[data-outputs]', 'flow.launch.invalidValue');
    const exposure = readInput(dialog, '[data-exposure]');
    if (exposure !== 'global' && exposure !== 'local') throw new Error(t('callable.exposure.invalid'));
    return { exposure, connections, defaultConnection, parameters, variables, defaults, runPolicy, outputs };
}

function readObject<T extends object>(root: HTMLElement, selector: string, errorKey: Parameters<typeof t>[0]): T {
    const value = JSON.parse(root.querySelector<HTMLTextAreaElement>(selector)!.value);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(t(errorKey));
    return value as T;
}

function readParameterRow(row: HTMLElement): FlowParameter {
    const name = readInput(row, '[data-param-name]').trim();
    const type = readInput(row, '[data-param-type]') as FlowParameter['type'];
    const required = row.querySelector<HTMLInputElement>('[data-param-required]')?.checked ?? false;
    const description = readInput(row, '[data-param-desc]').trim();
    if (!name) throw new Error(t('flow.settings.parameterNameRequired'));
    const raw = readInput(row, '[data-param-default]');
    const original = JSON.parse(row.dataset.paramOriginal ?? '{}') as FlowParameter;
    const result: FlowParameter = {...parameterPresentationValues(row, original, type), name, type,
        ...readParameterConstraints(row, type), ...(description ? {description} : {})};
    if (required) result.required = true;
    if (raw !== '') result.default = parseDefault(raw, type);
    return result;
}
function parameterPresentationValues(row: HTMLElement, original: FlowParameter, type: FlowParameter['type']): Partial<FlowParameter> {
    const { name: _name, type: _type, required: _required, description: _description, default: _default,
        minimum: _min, maximum: _max, integer: _integer, onMissing: _missing, imageConstraints: _images, fileConstraints: _files, ...presentation } = original;
    const result: Partial<FlowParameter> = {...presentation};
    const widget = readInput(row, '[data-param-widget]'), inputSource = readInput(row, '[data-param-source]');
    delete result.widget; delete result.inputSource; delete result.role;
    const role = readInput(row, '[data-param-role]');
    if (role) result.role = role as FlowParameter['role'];
    if (widget) result.widget = widget as FlowParameter['widget'];
    if (inputSource) result.inputSource = inputSource as FlowParameter['inputSource'];
    if (type !== 'json' && ['images', 'files'].includes(result.widget ?? '')) delete result.widget;
    if (type !== 'string') delete result.nonBlank;
    return result;
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
        if (!Number.isFinite(value)) throw new Error(t('flow.settings.numberDefaultInvalid'));
        return value;
    }
    if (type === 'boolean') return raw === 'true';
    if (type === 'json') return JSON.parse(raw) as JsonValue;
    return raw;
}

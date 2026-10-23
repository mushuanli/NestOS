import { ACTION_ICONS, FILE_BROWSER_ICONS, escapeHTML, randomUUID, t } from '@itookit/common';
import { editHarnessConnection } from './agent-harness-connections';
import { requestSettingsSave } from '@itookit/ui-common';
import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { renderAgentComposition, bindAgentComposition, readAgentComposition } from './agent-composition';
import { readAgentFlowFields, renderAgentFlowFields } from './agent-flow-fields';
import type { AgentExecutionOptions, AgentFlowChoice, AgentFlowDefinition, AgentFlowRevision } from './agent-execution-options';

export type { AgentFlowChoice } from './agent-execution-options';
type Defaults = { parameters?: Record<string, unknown>; connectionBindings?: Record<string, string> };
type Catalog = { revisions: AgentFlowRevision[]; latest?: AgentFlowRevision | null };

export function renderAgentExecution(agent: AgentDefinition, flows: AgentFlowChoice[], agents: AgentDefinition[] = []): string {
    const execution = agent.execution?.kind === 'flow' ? agent.execution : undefined;
    const composite = !!agent.composition;
    const harness = agent.execution?.kind === 'harness' ? agent.execution : undefined;
    const selected = execution?.flowId ?? flows[0]?.id ?? '';
    const choices = [...flows];
    if (selected && !choices.some(flow => flow.id === selected)) choices.push({ id: selected, name: t('agent.execution.missingFlow', { id: selected }) });
    return `<section class="agent-section" data-agent-execution data-bound-execution="${escapeHTML(JSON.stringify(agent.execution ?? {kind: 'agent'}))}">
        <button type="button" class="agent-section__header" aria-expanded="true"><span class="agent-section__icon">${ACTION_ICONS.run}</span><span class="agent-section__title">${t('agent.execution.title')}</span><span class="agent-section__toggle">${FILE_BROWSER_ICONS.chevron}</span></button>
        <div class="agent-section__body">
            <label class="agent-form-field">${t('agent.execution.title')}<select class="agent-form-select" name="executionKind"><option value="agent">${t('agent.execution.agent')}</option><option value="composite" ${composite ? 'selected' : ''}>${t('agent.composition.kind')}</option><option value="flow" ${execution && !composite ? 'selected' : ''}>${t('agent.execution.flow')}</option><option value="harness" ${harness ? 'selected' : ''}>${t('agent.execution.harness')}</option></select></label>
            <p class="agent-form-help" data-agent-binding-summary role="status"></p>
            ${renderAgentComposition(agent, agents)}
            ${renderHarnessFields(harness?.connectionId)}
            <fieldset class="agent-flow-fields__group" data-agent-flow-fields ${execution && !composite ? '' : 'hidden disabled'}>
                <div class="agent-form-grid">
                    <label class="agent-form-field">${t('agent.execution.definition')}<select class="agent-form-select" name="executionFlowId" required>${selected ? '' : `<option value="">${t('agent.execution.required')}</option>`}${choices.map(flow => `<option value="${escapeHTML(flow.id)}" ${selected === flow.id ? 'selected' : ''}>${escapeHTML(flow.name)}</option>`).join('')}</select></label>
                    <label class="agent-form-field">${t('agent.execution.revision')}<select class="agent-form-select" name="executionRevision">${revisionOptions([], execution?.revision)}</select></label>
                </div>
                <p class="agent-form-help" data-agent-flow-status role="status"></p>
                <button type="button" class="agent-prompt-btn" data-open-bound-flow hidden>${t('agent.execution.openFlow')}</button>
                <button type="button" class="agent-prompt-btn" data-agent-flow-retry hidden>${t('flow.parameters.retry')}</button>
                <div data-agent-flow-editor></div>
                <p class="agent-form-help">${t('agent.execution.promptHint')}</p>
            </fieldset>
        </div></section>`;
}

function renderHarnessFields(id?: string): string {
    return `<fieldset class="agent-flow-fields__group" data-agent-harness-fields ${id ? '' : 'hidden disabled'}>
                <label class="agent-form-field">${t('agent.execution.harnessConnection')}<select class="agent-form-select" name="executionHarnessConnection" required>
                    <option value="">${t('agent.execution.harnessRequired')}</option>${id ? `<option selected value="${escapeHTML(id)}">${escapeHTML(id)}</option>` : ''}
                </select></label><p class="agent-form-help" data-agent-harness-status role="status"></p>
                <button type="button" class="agent-prompt-btn" data-agent-harness-create>${t('agent.execution.harnessCreate')}</button>
                <button type="button" class="agent-prompt-btn" data-agent-harness-edit>${t('agent.execution.harnessEdit')}</button>
                <button type="button" class="agent-prompt-btn" data-agent-harness-retry>${t('flow.parameters.retry')}</button>
            </fieldset>`;
}

function revisionOptions(revisions: AgentFlowRevision[], selected?: number): string {
    const available = [...new Set(revisions.map(item => item.revision))].sort((a, b) => b - a);
    const missing = selected !== undefined && !available.includes(selected)
        ? `<option value="${selected}" selected>${escapeHTML(t('agent.execution.missingRevision', { revision: selected }))}</option>` : '';
    return `<option value="" ${selected === undefined ? 'selected' : ''}>${t('agent.execution.latest')}</option>${missing}${available.map(revision => `<option value="${revision}" ${revision === selected ? 'selected' : ''}>v${revision}</option>`).join('')}`;
}

function field(root: HTMLElement, name: string): HTMLSelectElement {
    return root.querySelector<HTMLSelectElement>(`[name="${name}"]`)!;
}

export function readAgentExecution(root: HTMLElement): AgentDefinition['execution'] {
    if (field(root, 'executionKind').value === 'harness') {
        const id = field(root, 'executionHarnessConnection').value;
        const section = root.querySelector<HTMLElement>('[data-agent-execution]')!;
        if (section.dataset.harnessState !== 'ready') throw new Error(section.dataset.harnessError || t('agent.execution.loading'));
        if (!id || field(root, 'executionHarnessConnection').selectedOptions[0]?.disabled) throw new Error(t('agent.execution.harnessRequired'));
        return { kind: 'harness', connectionId: id };
    }
    if (field(root, 'executionKind').value === 'composite') {
        readAgentComposition(root);
        return JSON.parse(root.querySelector<HTMLElement>('[data-agent-execution]')?.dataset.boundExecution ?? '{"kind":"agent"}') as AgentDefinition['execution'];
    }
    if (field(root, 'executionKind').value !== 'flow') return { kind: 'agent' };
    const flowId = field(root, 'executionFlowId').value;
    if (!flowId) throw new Error(t('agent.execution.required'));
    const section = root.querySelector<HTMLElement>('[data-agent-execution]')!;
    if (section.dataset.state !== 'ready') throw new Error(section.dataset.error || t('agent.execution.loading'));
    const revision = field(root, 'executionRevision').value;
    return { kind: 'flow', flowId, revision: revision ? Number(revision) : undefined, ...readAgentFlowFields(root) };
}

export function bindAgentExecution(root: HTMLElement, agent: AgentDefinition, flows: AgentFlowChoice[], options: AgentExecutionOptions = {}): AgentExecutionController {
    return new AgentExecutionController(root, agent, flows, options);
}

/** Own only form drafts and reads; publishing, persistence and execution stay with the host. */
export class AgentExecutionController {
    private generation = 0;
    private disposed = false;
    private pending?: Promise<void>;
    private interrupt?: () => void;
    private interrupted = new Promise<void>(resolve => { this.interrupt = resolve; });
    private readonly lifetime = new AbortController();
    private readonly views = new Map<string, HTMLElement>();
    private readonly defaults = new Map<string, Defaults>();
    private readonly catalog = new Map<string, Catalog>();
    private readonly selections = new Map<string, string>();
    private activeFlow?: string;
    private connections?: Array<{ id: string; name: string }>;
    private readonly section: HTMLElement;
    private readonly fields: HTMLFieldSetElement;
    private readonly status: HTMLElement;

    constructor(private readonly root: HTMLElement, agent: AgentDefinition, private readonly flows: AgentFlowChoice[], private readonly options: AgentExecutionOptions) {
        this.section = root.querySelector('[data-agent-execution]')!;
        this.fields = root.querySelector('[data-agent-flow-fields]')!;
        this.status = root.querySelector('[data-agent-flow-status]')!;
        if (agent.execution?.kind === 'flow') this.defaults.set(agent.execution.flowId, agent.execution);
        for (const name of ['executionKind', 'executionFlowId', 'executionRevision', 'executionHarnessConnection']) {
            field(root, name).addEventListener('change', () => this.update(true), { signal: this.lifetime.signal });
        }
        root.querySelector('[data-agent-flow-retry]')!.addEventListener('click', () => {
            this.catalog.delete(field(root, 'executionFlowId').value); this.connections = undefined; this.update(true);
        }, { signal: this.lifetime.signal });
        const open = root.querySelector<HTMLButtonElement>('[data-open-bound-flow]')!;
        open.hidden = !options.openFlow;
        open.addEventListener('click', () => { void this.openFlow(open); }, { signal: this.lifetime.signal });
        this.bindHarnessManagement();
        bindAgentComposition(root);
        this.update(false);
    }

    async ready(): Promise<void> {
        while (this.pending) {
            const pending = this.pending;
            await Promise.race([pending, this.interrupted]);
            if (this.pending === pending) return;
        }
    }

    destroy(): void { this.disposed = true; this.invalidate(); this.pending = undefined; this.lifetime.abort(); this.views.clear(); }

    private invalidate(): number {
        this.interrupt?.();
        this.interrupted = new Promise<void>(resolve => { this.interrupt = resolve; });
        return ++this.generation;
    }

    private update(changed: boolean): void {
        const enabled = field(this.root, 'executionKind').value === 'flow';
        const composite = field(this.root, 'executionKind').value === 'composite';
        const composition = this.root.querySelector<HTMLFieldSetElement>('[data-agent-composition]')!;
        composition.hidden = !composite; composition.disabled = !composite;
        this.summary();
        this.fields.hidden = !enabled; this.fields.disabled = !enabled;
        const generation = this.invalidate();
        const harness = field(this.root, 'executionKind').value === 'harness';
        const remote = this.root.querySelector<HTMLFieldSetElement>('[data-agent-harness-fields]')!;
        remote.hidden = !harness; remote.disabled = !harness;
        if (harness && !this.disposed) { this.pending = this.loadHarness(generation, changed); return; }
        if (!enabled || this.disposed) { this.pending = undefined; return; }
        this.capture();
        this.pending = this.load(generation, changed);
    }

    private bindHarnessManagement(): void {
        for (const action of ['create', 'edit']) {
            const button = this.root.querySelector<HTMLButtonElement>(`[data-agent-harness-${action}]`)!;
            button.hidden = !this.options.harnessConnections;
            button.addEventListener('click', () => { void this.editHarness(button, action === 'edit'); }, { signal: this.lifetime.signal });
        }
        this.root.querySelector('[data-agent-harness-retry]')!.addEventListener('click', () => this.update(false), { signal: this.lifetime.signal });
    }

    private async editHarness(button: HTMLButtonElement, edit: boolean): Promise<void> {
        const port = this.options.harnessConnections;
        const id = edit ? field(this.root, 'executionHarnessConnection').value : undefined;
        if (!port || (edit && !id)) return;
        const generation = this.generation, started = performance.now(), operationId = randomUUID();
        button.disabled = true;
        try {
            await editHarnessConnection(port, id, savedId => {
                if (!this.current(generation)) return;
                const select = field(this.root, 'executionHarnessConnection');
                select.add(new Option(savedId, savedId, true, true)); this.update(true);
            }, () => this.current(generation));
        } catch {
            if (this.current(generation)) this.root.querySelector<HTMLElement>('[data-agent-harness-status]')!.textContent = t('agent.execution.harnessUnavailable');
            console.error('agent.harness.connection.catalog.failed', { operation: 'harness.connection.configure',
                operationId, stage: 'targets', result: 'failure', code: 'HARNESS_TARGETS_UNAVAILABLE', durationMs: Math.round(performance.now() - started) });
        } finally { if (!this.disposed) button.disabled = false; }
    }

    private async loadHarness(generation: number, changed: boolean): Promise<void> {
        const status = this.root.querySelector<HTMLElement>('[data-agent-harness-status]')!;
        this.section.dataset.harnessState = 'loading';
        status.textContent = t('agent.execution.loading');
        const started = performance.now(), operationId = randomUUID();
        try {
            const list = await this.options.listHarnessConnections?.() ?? [];
            if (!this.current(generation)) return;
            const select = field(this.root, 'executionHarnessConnection'), selected = select.value;
            const options = list.map(item => `<option value="${escapeHTML(item.id)}" ${item.id === selected ? 'selected' : ''} ${item.enabled === false ? 'disabled' : ''}>${escapeHTML(item.name)}</option>`);
            if (selected && !list.some(item => item.id === selected)) options.unshift(`<option value="${escapeHTML(selected)}" selected disabled>${escapeHTML(selected)}</option>`);
            select.innerHTML = `<option value="">${t('agent.execution.harnessRequired')}</option>${options.join('')}`;
            this.section.dataset.harnessState = 'ready'; this.section.dataset.harnessError = '';
            status.textContent = t(list.length ? 'agent.execution.harnessHint' : 'agent.execution.harnessEmpty');
            console.info('agent.harness.configuration.loaded', { operation: 'agent.harness.configuration', operationId, stage: 'catalog', result: 'success', count: list.length, durationMs: Math.round(performance.now() - started) });
            if (changed) requestSettingsSave(this.root);
        } catch {
            if (!this.current(generation)) return;
            this.section.dataset.harnessState = 'error'; this.section.dataset.harnessError = t('agent.execution.harnessUnavailable');
            status.textContent = this.section.dataset.harnessError;
            console.error('agent.harness.configuration.failed', { operation: 'agent.harness.configuration', operationId, stage: 'catalog', result: 'failure', code: 'HARNESS_CATALOG_UNAVAILABLE', durationMs: Math.round(performance.now() - started) });
        }
    }

    private capture(): void {
        if (!this.activeFlow || this.section.dataset.state !== 'ready') return;
        this.selections.set(this.activeFlow, field(this.root, 'executionRevision').value);
        try { this.defaults.set(this.activeFlow, readAgentFlowFields(this.root)); }
        catch { /* Keep the existing DOM draft, including invalid input, for correction. */ }
    }

    private async load(generation: number, changed: boolean): Promise<void> {
        const flowId = field(this.root, 'executionFlowId').value;
        const operationId = randomUUID(), started = performance.now();
        this.setState('loading', t('agent.execution.loading'));
        try {
            if (!this.flows.some(flow => flow.id === flowId)) throw new Error(t(this.flows.length ? 'agent.execution.required' : 'agent.execution.noFlows'));
            const data = await this.loadCatalog(flowId, operationId);
            if (!this.current(generation)) return;
            this.apply(flowId, data);
            console.info('agent.flow.configuration.loaded', { operation: 'agent.flow.configuration', operationId, stage: 'render', result: 'success', durationMs: Math.round(performance.now() - started), revisionCount: data.revisions.length });
            if (changed) requestSettingsSave(this.root);
        } catch (error) {
            if (!this.current(generation)) return;
            this.setState('error', error instanceof Error ? error.message : t('agent.execution.unavailable'));
            console.error('agent.flow.configuration.failed', { operation: 'agent.flow.configuration', operationId, stage: 'load', result: 'failure', code: 'FLOW_CONFIGURATION_LOAD_FAILED', durationMs: Math.round(performance.now() - started) });
        }
    }

    private async loadCatalog(id: string, operationId: string): Promise<Catalog> {
        let data = this.catalog.get(id);
        if (!data) {
            const [revisions, latest] = await Promise.all([
                this.stage('revisions', operationId, () => this.options.listFlowRevisions?.(id) ?? Promise.resolve([])),
                this.stage('definition', operationId, () => this.options.getFlowRevision?.(id) ?? Promise.resolve(undefined)),
            ]);
            data = { revisions, latest }; this.catalog.set(id, data);
        }
        this.connections ??= await this.stage('connections', operationId, () => this.options.listConnections?.() ?? Promise.resolve([]));
        return data;
    }

    private async stage<T>(stage: string, operationId: string, read: () => Promise<T>): Promise<T> {
        const started = performance.now();
        try { return await read(); }
        catch (error) {
            console.error('agent.flow.configuration.read.failed', { operation: 'agent.flow.configuration', operationId, stage, result: 'failure', code: `FLOW_${stage.toUpperCase()}_READ_FAILED`, durationMs: Math.round(performance.now() - started) });
            throw error;
        }
    }

    private apply(flowId: string, data: Catalog): void {
        const revisionField = field(this.root, 'executionRevision');
        const raw = this.activeFlow && this.activeFlow !== flowId ? this.selections.get(flowId) ?? '' : revisionField.value;
        const selected = raw ? Number(raw) : undefined;
        revisionField.innerHTML = revisionOptions(data.revisions, selected);
        const latest = this.options.getFlowRevision ? data.latest : [...data.revisions].sort((a, b) => b.revision - a.revision)[0];
        const revision = selected === undefined ? latest : data.revisions.find(item => item.revision === selected);
        if (selected !== undefined && !revision) throw new Error(t('agent.execution.missingRevision', { revision: selected }));
        const definition: AgentFlowDefinition = revision ?? this.flows.find(flow => flow.id === flowId)!;
        const key = JSON.stringify([flowId, selected ?? 'latest']);
        let view = this.views.get(key);
        if (!view) {
            view = document.createElement('div');
            view.innerHTML = renderAgentFlowFields(definition, this.defaults.get(flowId) ?? {}, this.connections ?? []);
            this.views.set(key, view);
        }
        this.root.querySelector('[data-agent-flow-editor]')!.replaceChildren(view);
        this.activeFlow = flowId;
        this.setState('ready', revision ? t('agent.execution.inheritHint') : t('agent.execution.unpublished'));
        this.summary();
    }

    private current(generation: number): boolean { return !this.disposed && this.generation === generation; }

    syncSaved(agent: AgentDefinition): void {
        this.section.dataset.boundExecution = JSON.stringify(agent.execution ?? {kind: 'agent'});
        this.summary();
    }

    private async openFlow(button: HTMLButtonElement): Promise<void> {
        button.disabled = true;
        try { await this.options.openFlow?.(field(this.root, 'executionFlowId').value); }
        catch (error) {
            if (this.disposed) return;
            this.status.textContent = error instanceof Error ? error.message : String(error);
            this.status.setAttribute('role', 'alert');
        } finally { if (!this.disposed) button.disabled = false; }
    }

    private summary(): void {
        const kind = field(this.root, 'executionKind').value;
        const revision = field(this.root, 'executionRevision').value;
        const name = field(this.root, 'executionFlowId').selectedOptions[0]?.textContent ?? '';
        this.root.querySelector('[data-agent-binding-summary]')!.textContent = kind === 'flow'
            ? t('agent.execution.boundSummary', { name, version: revision ? `v${revision}` : 'latest' })
            : t(kind === 'harness' ? 'agent.execution.harnessHint' : kind === 'composite' ? 'agent.composition.hint' : 'agent.execution.directSummary');
        const status = this.root.querySelector('[data-agent-composition-status]');
        if (status && kind === 'composite') {
            const binding = JSON.parse(this.section.dataset.boundExecution ?? '{}') as AgentDefinition['execution'];
            status.textContent = binding?.kind === 'flow' ? t('agent.composition.bound', { version: binding.revision ?? 'latest' }) : t('agent.composition.pending');
        }
    }

    private setState(state: 'loading' | 'ready' | 'error', message: string): void {
        this.section.dataset.state = state; this.section.dataset.error = state === 'error' ? message : '';
        this.status.textContent = message; this.status.setAttribute('role', state === 'error' ? 'alert' : 'status');
        this.section.setAttribute('aria-busy', String(state === 'loading'));
        this.root.querySelector<HTMLButtonElement>('[data-agent-flow-retry]')!.hidden = state !== 'error';
        this.root.querySelector<HTMLElement>('[data-agent-flow-editor]')!.hidden = state !== 'ready';
    }
}

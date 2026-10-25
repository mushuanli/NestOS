import {assertContextOptionsPage, assertContextOptionSelection} from '../../domain/context-options';
import {createModuleLogger, escapeHTML, randomUUID, t} from '@itookit/common';
import {type TargetRef} from '@itookit/llm-flow/contracts';
import type {ContextOptionsPage, ContextOptionsQuery, ContextSourceOption, ContextCheckpointOption} from '@itookit/llm-session/contracts';
import {prepareInputContextDraft, sameInputContextDraft, type InputContextDraft} from '../../domain/context-draft';

export interface ContextScope {sessionId: string; branchId: string}
export interface ContextPickerState {scope?: ContextScope; target?: TargetRef; draft?: InputContextDraft; overrides?: ContextOptionsQuery['overrides']}
export type ContextOptionsPort = (query: ContextOptionsQuery) => Promise<ContextOptionsPage>;
const log = createModuleLogger('workspace-context');

/** The composer owns selections. Pages and qualification are disposable observations only. */
export class WorkspaceContextPicker {
    readonly element = document.createElement('section');
    private state: ContextPickerState = {};
    private scopeKey = '';
    private destinationKey = '';
    private generation = 0;
    private sequence = 0;
    private revision = 0;
    private closed = false;
    private expanded = false;
    private loading = false;
    private error?: string;
    private verified?: string;
    private page?: ContextOptionsPage;
    private sources: ContextSourceOption[] = [];
    private checkpoints: ContextCheckpointOption[] = [];
    private bindingId?: string;
    private candidate?: InputContextDraft['selection'];
    private readonly clicked = (event: Event) => this.click(event);
    constructor(host: HTMLElement, private readonly read: () => ContextOptionsPort | undefined, private readonly changed: (value?: InputContextDraft) => void,
        private readonly revisionFloor: () => number = () => 0) {
        this.element.className = 'workspace-context'; this.element.addEventListener('click', this.clicked); host.append(this.element);
    }
    update(state: ContextPickerState): void {
        if (this.closed) return;
        const key = JSON.stringify([state.scope, state.target, state.overrides]), changed = key !== this.scopeKey;
        const destination = JSON.stringify([state.scope, state.target]), discover = destination !== this.destinationKey;
        this.destinationKey = destination;
        if (!sameInputContextDraft(state.draft, this.state.draft)) {++this.sequence; this.loading = false; this.verified = undefined;}
        this.revision = Math.max(this.revision, state.draft?.revision ?? 0);
        this.state = structuredClone(state);
        if (changed) {this.scopeKey = key; this.invalidate(); if (discover) this.page = undefined; this.expanded = false; this.verified = undefined;}
        this.render(); if (changed && discover && this.query()) void this.load();
    }
    invalidate(): void {++this.generation; ++this.sequence; this.loading = false; this.candidate = undefined; this.error = undefined; this.sources = []; this.checkpoints = []; this.bindingId = undefined;}
    destroy(): void {this.closed = true; this.invalidate(); this.element.removeEventListener('click', this.clicked); this.element.remove();}
    async prepare(): Promise<boolean> {
        const draft = this.state.draft; if (!draft) return true;
        const sequence = this.begin();
        try {
            prepareInputContextDraft(draft, {...this.state.scope, sessionId: this.state.scope?.sessionId ?? '', target: this.state.target});
            const selection = draft.selection;
            const page = await this.request(selection.mode === 'fork' ? {bindingId: selection.sourceBindingId, checkpointRef: selection.checkpointRef} : {}, sequence);
            assertContextOptionSelection(page, draft); this.verified = JSON.stringify(draft); this.error = undefined; this.render(); return true;
        } catch (error) {if (sequence === this.sequence) this.failed(error); return false;}
        finally {this.finish(sequence);}
    }
    private query(): ContextOptionsQuery | undefined {
        if (this.closed || !this.read() || !this.state.scope || !this.state.target) return;
        return {...this.state.scope, target: structuredClone(this.state.target), overrides: structuredClone(this.state.overrides), limit: 25};
    }
    private async request(extra: Partial<ContextOptionsQuery>, sequence: number): Promise<ContextOptionsPage> {
        const query = this.query(); if (!query) throw failure('CONTEXT_OPTIONS_UNAVAILABLE');
        const generation = this.generation, operationId = randomUUID(), started = Date.now();
        try {
            const page = await this.read()!({...query, ...extra});
            this.assertCurrent(sequence, generation);
            assertContextOptionsPage(page, query); report(operationId, started); return page;
        } catch (error) {this.assertCurrent(sequence, generation); report(operationId, started, error); throw error;}
    }
    private async load(bindingId?: string, append = false): Promise<void> {
        const sequence = this.begin();
        try {
            const cursor = append ? this.page?.nextCursor : undefined;
            const page = await this.request({bindingId, ...(cursor ? {cursor} : {})}, sequence);
            if (append && this.page?.basis !== page.basis) throw failure('CONTEXT_CATALOG_CHANGED');
            this.install(page, bindingId, append);
        } catch (error) {if (sequence === this.sequence) this.failed(error);}
        finally {this.finish(sequence);}
    }
    private begin(): number {const sequence = ++this.sequence; this.loading = true; this.error = undefined; this.render(); return sequence;}
    private finish(sequence: number): void {if (!this.closed && sequence === this.sequence) {this.loading = false; this.render();}}
    private assertCurrent(sequence: number, generation: number): void {
        if (this.closed || sequence !== this.sequence || generation !== this.generation) throw failure('CONTEXT_VIEW_CHANGED');
    }
    private install(page: ContextOptionsPage, bindingId: string | undefined, append: boolean): void {
        this.page = page; this.bindingId = bindingId; this.candidate = undefined;
        if (bindingId) this.checkpoints = [...(append ? this.checkpoints : []), ...page.checkpoints ?? []];
        else this.sources = [...(append ? this.sources : []), ...page.sources];
    }
    private failed(error: unknown): void {
        if (this.closed || errorCode(error) === 'CONTEXT_VIEW_CHANGED') return;
        this.verified = undefined; this.error = t('callable.context.failed', {code: errorCode(error)});
        if (['CONTEXT_CATALOG_CHANGED', 'CONTEXT_OPTIONS_CHANGED'].includes(errorCode(error))) {this.page = undefined; this.sources = []; this.checkpoints = []; this.candidate = undefined;}
        this.render();
    }
    private render(): void {
        if (this.closed) return;
        this.element.hidden = !this.state.draft && (!this.query() || this.page?.kind === 'other');
        this.element.innerHTML = `<button type="button" data-context-action="open">${escapeHTML(t('callable.context.title'))}: ${escapeHTML(this.summary())}</button>
            ${this.state.draft ? this.action('clear', 'callable.context.clear') + this.action('verify', 'callable.context.verify', this.loading) : ''}
            <p role="status">${escapeHTML(this.notice())}</p>${this.error ? `<p role="alert">${escapeHTML(this.error)}</p>` : ''}
            ${this.state.draft?.selection.mode === 'fork' ? `<p>${escapeHTML(t('callable.context.forkBoundary'))}</p>` : ''}
            ${this.expanded ? this.panel() : ''}`;
    }
    private summary(): string {
        const selection = this.state.draft?.selection;
        return selection?.mode === 'fork' ? t('callable.context.selected', {checkpoint: selection.checkpointRef}) : t('callable.context.new');
    }
    private notice(): string {
        const stale = this.state.draft && this.verified !== JSON.stringify(this.state.draft);
        const state = stale ? t('callable.context.revalidate') : this.state.draft ? t('callable.context.dynamicPolicy') : '';
        return [this.loading ? t('callable.context.loading') : '', state].filter(Boolean).join(' ');
    }
    private panel(): string {
        return `<div class="workspace-context__panel">${this.action('new', 'callable.context.new')}${this.action('refresh', 'callable.context.refresh', this.loading)}
            <p>${escapeHTML(t('callable.context.continueUnsupported'))}</p><p>${escapeHTML(t('callable.context.forkBoundary'))}</p>
            ${this.bindingId ? this.action('back', 'callable.context.bindings', this.loading) : ''}
            <div class="workspace-context__rows">${this.rows()}</div>
            ${this.page?.nextCursor ? this.action('more', 'callable.context.more', this.loading) : ''}
            ${this.candidate ? this.action('confirm', 'callable.context.confirm') : ''}</div>`;
    }
    private rows(): string {
        if (this.page?.kind !== 'direct-harness') return '';
        if (this.bindingId) return this.checkpoints.map((row, index) => this.row('checkpoint', index, row.ref, row.fork.status !== 'static-compatible', row.fork.codes)).join('');
        return this.sources.map((row, index) => this.row('binding', index, `${row.branchId} · ${row.ref.bindingId}`, row.fork.status !== 'static-compatible', row.fork.codes)).join('');
    }
    private row(kind: string, index: number, label: string, disabled: boolean, codes: string[]): string {
        return `<button type="button" data-context-${kind}="${index}" ${disabled || this.loading ? 'disabled' : ''}>${escapeHTML(label)}${codes.length ? ` (${escapeHTML(codes.join(', '))})` : ''}</button>`;
    }
    private action(action: string, key: Parameters<typeof t>[0], disabled = false): string {
        return `<button type="button" data-context-action="${action}" ${disabled ? 'disabled' : ''}>${escapeHTML(t(key))}</button>`;
    }
    private click(event: Event): void {
        if (this.closed || !(event.target instanceof Element)) return;
        const button = event.target.closest<HTMLButtonElement>('button'); if (!button || button.disabled) return;
        if (button.dataset.contextBinding !== undefined) {void this.load(this.sources[Number(button.dataset.contextBinding)]?.ref.bindingId); return;}
        if (button.dataset.contextCheckpoint !== undefined) {this.chooseCheckpoint(Number(button.dataset.contextCheckpoint)); return;}
        this.act(button.dataset.contextAction);
    }
    private act(action?: string): void {
        if (action === 'clear' || action === 'new') {this.changed(undefined); return;}
        if (action === 'verify') {void this.prepare(); return;}
        if (action === 'confirm') {this.confirm(); return;}
        if (action === 'open') {this.expanded = !this.expanded; if (this.expanded) void this.load(); this.render(); return;}
        if (action === 'refresh' || action === 'back') {void this.load(); return;}
        if (action === 'more') void this.load(this.bindingId, true);
    }
    private chooseCheckpoint(index: number): void {
        const source = this.page?.sources.find(row => row.ref.bindingId === this.bindingId), checkpoint = this.checkpoints[index];
        if (!source || checkpoint?.fork.status !== 'static-compatible' || !this.page?.modes.fork.supported) return;
        this.candidate = {mode: 'fork', sourceBindingId: source.ref.bindingId, expectedBindingRevision: source.ref.revision,
            expectedGeneration: source.ref.generation, checkpointRef: checkpoint.ref}; this.render();
    }
    private confirm(): void {
        if (!this.candidate || !this.state.scope || !this.state.target) return;
        this.revision = Math.max(this.revision, this.revisionFloor()) + 1;
        this.changed({revision: this.revision, ...this.state.scope, target: structuredClone(this.state.target), selection: structuredClone(this.candidate)});
        this.expanded = false; this.render();
    }
}

function failure(code: string): Error {return Object.assign(new Error(code), {code});}
function errorCode(error: unknown): string {const code = (error as {code?: unknown})?.code; return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CONTEXT_OPTIONS_READ_FAILED';}
function report(operationId: string, started: number, error?: unknown): void {
    const data = {operation: 'context.options', operationId, stage: 'read', result: error ? 'failure' : 'observed', durationMs: Date.now() - started, ...(error ? {code: errorCode(error)} : {})};
    if (error) log.warn('Context options', data); else log.info('Context options', data);
}

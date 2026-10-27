import {escapeHTML, t} from '@itookit/common';
import type {JsonValue} from '@itookit/llm-flow/contracts';
import type {EntityOption} from '../components/dag/FlowSettingsDialog';
import {SchemaForm} from '../components/dag/SchemaForm';

export interface ToolCallValue {toolId: string; toolVersion: string; args: Record<string, JsonValue>}

interface Options {signal?: AbortSignal; mcpOnly?: boolean; initial?: ToolCallValue}

/** Opening, searching and editing a tool never executes it. */
export function promptToolCall(tools: EntityOption[], options: Options = {}): Promise<ToolCallValue | null> {
    if (options.signal?.aborted) return Promise.resolve(null);
    return new ToolCallForm(tools.filter(tool => !options.mcpOnly || tool.id.startsWith('mcp__')), options).open();
}

class ToolCallForm {
    private readonly dialog = document.createElement('dialog');
    private readonly drafts = new Map<string, Record<string, JsonValue>>();
    private form?: SchemaForm;
    private previous = '';
    private result: ToolCallValue | null = null;
    private select: HTMLSelectElement;
    constructor(private readonly tools: EntityOption[], private readonly options: Options) {
        this.dialog.className = 'dag-dialog';
        this.dialog.innerHTML = toolFormMarkup(tools);
        this.select = this.dialog.querySelector<HTMLSelectElement>('[data-tool]')!;
        if (options.initial) this.drafts.set(options.initial.toolId, options.initial.args);
        this.select.addEventListener('change', () => this.change());
        this.dialog.querySelector('form')!.addEventListener('submit', event => {event.preventDefault(); this.submit();});
        bindSearch(this.dialog, this.select, tools);
    }
    open(): Promise<ToolCallValue | null> {
        return new Promise(resolve => {
            const abort = () => this.dialog.close();
            this.dialog.querySelector('[data-cancel]')!.addEventListener('click', abort);
            this.options.signal?.addEventListener('abort', abort, {once: true});
            this.dialog.addEventListener('close', () => {
                this.options.signal?.removeEventListener('abort', abort);
                this.dialog.remove(); resolve(this.options.signal?.aborted ? null : this.result);
            }, {once: true});
            document.body.append(this.dialog); this.dialog.showModal();
            if (this.options.initial) {this.select.value = this.options.initial.toolId; this.change();}
        });
    }
    private change(): void {
        if (this.previous && this.form) {
            const saved = this.form.read();
            if (saved.value) this.drafts.set(this.previous, saved.value as Record<string, JsonValue>);
        }
        this.previous = this.select.value;
        const selected = this.tools.find(tool => tool.id === this.select.value);
        this.dialog.querySelector('[data-tool-description]')!.textContent = selected?.description ?? '';
        this.form = new SchemaForm(this.dialog.querySelector('[data-tool-args]')!,
            (selected?.parameters ?? {type: 'object'}) as JsonValue, this.drafts.get(this.select.value) ?? {});
        this.form.render();
        this.dialog.querySelector('[data-error]')!.textContent = '';
    }
    private submit(): void {
        const selected = this.tools.find(tool => tool.id === this.select.value), args = this.form?.read();
        if (!selected || !args?.value || args.errors.length) {
            this.dialog.querySelector('[data-error]')!.textContent = args?.errors.join('; ') || t('flow.tool.required'); return;
        }
        const version = this.options.initial?.toolId === selected.id ? this.options.initial.toolVersion : '1';
        this.result = {toolId: selected.id, toolVersion: selected.version ?? version, args: args.value as Record<string, JsonValue>};
        this.dialog.close();
    }
}

function toolFormMarkup(tools: EntityOption[]): string {
    return `<form><h2>${escapeHTML(t('flow.tool.title'))}</h2>
        <label>${escapeHTML(t('flow.tool.search'))}<input type="search" data-tool-search></label>
        <label>${escapeHTML(t('flow.tool.select'))}<select data-tool required><option value=""></option>${tools.map(tool =>
            `<option value="${escapeHTML(tool.id)}">${escapeHTML(`${tool.id.startsWith('mcp__') ? 'MCP' : t('flow.tool.local')} · ${tool.name}`)}</option>`).join('')}</select></label>
        <p data-tool-description></p><div data-tool-args></div>
        <p>${escapeHTML(t('flow.tool.deferred'))}</p><p role="alert" class="dag-dialog__error" data-error></p>
        <menu><button type="button" data-cancel>${escapeHTML(t('flow.launch.cancel'))}</button>
            <button type="submit">${escapeHTML(t('action.confirm'))}</button></menu></form>`;
}

function bindSearch(dialog: HTMLDialogElement, select: HTMLSelectElement, tools: EntityOption[]): void {
    dialog.querySelector<HTMLInputElement>('[data-tool-search]')!.addEventListener('input', event => {
        const query = (event.target as HTMLInputElement).value.trim().toLowerCase();
        for (const option of select.options) {
            const tool = tools.find(item => item.id === option.value);
            option.hidden = Boolean(tool && !`${tool.id} ${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query));
        }
    });
}

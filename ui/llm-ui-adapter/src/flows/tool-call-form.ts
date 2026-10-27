import {escapeHTML, t} from '@itookit/common';
import type {JsonValue} from '@itookit/llm-flow/contracts';
import type {EntityOption} from '../components/dag/FlowSettingsDialog';
import {SchemaForm} from '../components/dag/SchemaForm';

export interface ToolCallValue {toolId: string; toolVersion: string; args: Record<string, JsonValue>}

/** Opening, searching and editing a tool never executes it. */
export function promptToolCall(tools: EntityOption[], options: {signal?: AbortSignal; mcpOnly?: boolean; initial?: ToolCallValue} = {}): Promise<ToolCallValue | null> {
    if (options.signal?.aborted) return Promise.resolve(null);
    const available = tools.filter(tool => !options.mcpOnly || tool.id.startsWith('mcp__'));
    return new Promise(resolve => {
        const dialog = document.createElement('dialog'); dialog.className = 'dag-dialog';
        dialog.innerHTML = `<form><h2>${escapeHTML(t('flow.tool.title'))}</h2>
            <label>${escapeHTML(t('flow.tool.search'))}<input type="search" data-tool-search></label>
            <label>${escapeHTML(t('flow.tool.select'))}<select data-tool required><option value=""></option>${available.map(tool =>
                `<option value="${escapeHTML(tool.id)}">${escapeHTML(`${tool.id.startsWith('mcp__') ? 'MCP' : t('flow.tool.local')} · ${tool.name}`)}</option>`).join('')}</select></label>
            <p data-tool-description></p><div data-tool-args></div>
            <p>${escapeHTML(t('flow.tool.deferred'))}</p><p role="alert" class="dag-dialog__error" data-error></p>
            <menu><button type="button" data-cancel>${escapeHTML(t('flow.launch.cancel'))}</button>
                <button type="submit">${escapeHTML(t('action.confirm'))}</button></menu></form>`;
        const select = dialog.querySelector<HTMLSelectElement>('[data-tool]')!;
        let form: SchemaForm | undefined, result: ToolCallValue | null = null;
        const drafts = new Map<string, Record<string, JsonValue>>();
        if (options.initial) drafts.set(options.initial.toolId, options.initial.args);
        let previous = '';
        select.addEventListener('change', () => {
            if (previous && form) {const saved = form.read(); if (saved.value) drafts.set(previous, saved.value as Record<string, JsonValue>);}
            previous = select.value;
            const selected = available.find(tool => tool.id === select.value);
            dialog.querySelector('[data-tool-description]')!.textContent = selected?.description ?? '';
            form = new SchemaForm(dialog.querySelector('[data-tool-args]')!,
                (selected?.parameters ?? {type: 'object'}) as JsonValue, drafts.get(select.value) ?? {});
            form.render();
        });
        bindSearch(dialog, select, available);
        const abort = () => dialog.close();
        dialog.querySelector('[data-cancel]')!.addEventListener('click', abort);
        dialog.querySelector('form')!.addEventListener('submit', event => {
            event.preventDefault();
            const selected = available.find(tool => tool.id === select.value), args = form?.read();
            if (!selected || !args?.value || args.errors.length) {
                dialog.querySelector('[data-error]')!.textContent = args?.errors.join('; ') || t('flow.tool.required'); return;
            }
            result = {toolId: selected.id, toolVersion: selected.version ?? options.initial?.toolVersion ?? '1', args: args.value as Record<string, JsonValue>};
            dialog.close();
        });
        options.signal?.addEventListener('abort', abort, {once: true});
        dialog.addEventListener('close', () => {
            options.signal?.removeEventListener('abort', abort); dialog.remove(); resolve(options.signal?.aborted ? null : result);
        }, {once: true});
        document.body.append(dialog); dialog.showModal();
        if (options.initial) {select.value = options.initial.toolId; select.dispatchEvent(new Event('change'));}
    });
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

import {mountResourceSearch} from './resource-search';
import {pickOutputSource} from './output-source-picker';
import {createModuleLogger, randomUUID, t} from '@itookit/common';
import {ResourceCommand, type ResourceContent, type ResourceScope} from '@itookit/app-contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import type {FlowParameter} from '@itookit/llm-flow/contracts';
import {parameterSourceValue} from './flow-arguments';

/** A source is read only on explicit selection; confirmed values use the ordinary parameter schema. */
export class ParameterSources {
    private abort = new AbortController();
    private invalid = new Set<string>();
    private pending = new Set<string>();
    constructor(private commands: ICommandBus, private scope: ResourceScope, private fields: FlowParameter[]) {}
    mount(root: HTMLElement): () => void {
        for (const [index, field] of this.fields.entries()) {
            if (field.presentation?.contentSource === false || !!field.role && field.role !== 'input' || ['images', 'files'].includes(field.widget ?? '')) continue;
            const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-parameter="${index}"]`);
            if (input) this.mountField(input, field);
        }
        return () => this.abort.abort();
    }
    validate(): void {if (this.invalid.size) throw new Error(t('flow.source.notPrepared')); if (this.pending.size) throw new Error(t('flow.source.preparing'));}
    private mountField(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, field: FlowParameter): void {
        const box = document.createElement('details'), title = document.createElement('summary'), reference = document.createElement('input');
        box.className = 'flow-content-source'; title.textContent = t('flow.source.choose');
        reference.placeholder = '@notes:/document.md'; reference.setAttribute('aria-label', t('flow.source.reference'));
        const button = document.createElement('button'); button.type = 'button'; button.textContent = t('flow.source.prepare');
        const file = document.createElement('input'); file.type = 'file'; file.accept = '.md,.txt,.json,.yaml,.yml,.csv';
        file.setAttribute('aria-label', t('flow.source.localFile'));
        const status = document.createElement('p'); status.setAttribute('role', 'status');
        const preview = document.createElement('pre');
        box.append(title, reference, mountResourceSearch(reference, this.commands, this.scope, this.abort.signal), button, file, status, preview); input.closest('.llm-parameter-field')!.append(box);
        let revision = 0;
        const read = async (work: () => Promise<unknown>) => {
            const current = ++revision, operationId = randomUUID(), started = Date.now(); this.pending.add(field.name); this.invalid.add(field.name); status.textContent = t('flow.source.preparing'); button.disabled = true;
            try {
                const value = parameterSourceValue(await work(), field);
                if (this.abort.signal.aborted || current !== revision) return;
                if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = value === true;
                else {
                    const encoded = typeof value === 'string' && field.type !== 'json' && !input.hasAttribute('data-parameter-enum') ? value : JSON.stringify(value);
                    if (input instanceof HTMLSelectElement && ![...input.options].some(option => option.value === encoded)) throw new Error(t('flow.source.typeMismatch'));
                    input.value = encoded;
                }
                input.dispatchEvent(new Event('change', {bubbles: true}));
                this.invalid.delete(field.name);
                preview.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); status.textContent = t('flow.source.ready');
                createModuleLogger('parameter-source').info('parameter.source', {operationId, stage: 'apply', result: 'success', durationMs: Date.now() - started});
            } catch (error) {
                if (!this.abort.signal.aborted && current === revision) status.textContent = error instanceof Error ? error.message : String(error);
                createModuleLogger('parameter-source').warn('parameter.source', {operationId, stage: 'read', result: 'failure', code: 'PARAMETER_SOURCE_READ_FAILED', durationMs: Date.now() - started});
            } finally {if (current === revision) {this.pending.delete(field.name); button.disabled = false;}}
        };
        input.addEventListener('input', () => {revision++; this.invalid.delete(field.name); this.pending.delete(field.name); button.disabled = false;}, {signal: this.abort.signal});
        reference.oninput = () => {reference.setCustomValidity(''); revision++; this.invalid.add(field.name); this.pending.delete(field.name); button.disabled = false; preview.textContent = '';};
        button.onclick = () => {void read(async () => (await this.commands.execute<ResourceContent>(ResourceCommand.Read, {reference: reference.value, scope: this.scope})).text);};
        const output = document.createElement('button'); output.type = 'button'; output.textContent = t('flow.source.output'); box.append(output);
        output.onclick = async () => {const current = revision;
            const selected = await pickOutputSource(this.commands, this.scope, this.abort.signal);
            if (selected && !this.abort.signal.aborted && current === revision) void read(async () => selected.value);};
        file.onchange = () => {const selected = file.files?.[0]; if (selected) void read(async () => {
            if (selected.size > 2 * 1024 * 1024) throw new Error(t('flow.source.fileTooLarge'));
            const bytes = await selected.arrayBuffer(), text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
            if (text.includes('\0')) throw new Error(t('flow.source.textRequired')); return text;
        });};
    }
}

import { t } from '@itookit/common';
import { ContentTransferCommand, type ContentCapture, type ContentTransfer, type ICommandBus, type TransferReference } from '@itookit/llm-session/contracts';
import type { FlowParameter, JsonValue } from '@itookit/llm-flow/contracts';
import type { FlowParameterExtension } from '../components/FlowParameterForm';
import { ContentSourcePicker } from './content-source-picker';

/** Per-field bindings never change a Session's default history policy. */
export class FlowInputSources implements FlowParameterExtension {
    private capture?: Promise<ContentCapture>;
    private transfers = new Map<string, ContentTransfer>();
    private pickers: ContentSourcePicker[] = [];
    constructor(private commands: ICommandBus, private sessionId: string, private fields: FlowParameter[], private names?: string[]) {}
    mount(root: HTMLElement): () => void {
        const events = new AbortController();
        this.fields.forEach((field, index) => {
            if (this.names && !this.names.includes(field.name)) return;
            if (field.widget === 'images' || field.widget === 'files') return;
            const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-parameter="${index}"]`);
            if (!input) return;
            const parent = input.closest<HTMLElement>('.llm-parameter-field')!, wrapper = document.createElement('div');
            wrapper.className = 'flow-content-field'; parent.before(wrapper); wrapper.append(parent);
            const picker = new ContentSourcePicker(wrapper, { commands: this.commands, sessionId: this.sessionId,
                capture: () => this.readCapture(), clear: () => this.transfers.delete(field.name),
                apply: transfer => this.bind(field, input, transfer) });
            input.addEventListener('input', () => picker.edited(), { signal: events.signal });
            this.pickers.push(picker);
        });
        return () => { events.abort(); this.pickers.forEach(picker => picker.destroy()); this.pickers = []; };
    }
    validate(): void { this.pickers.forEach(picker => picker.validate()); }
    bindings(values: Record<string, JsonValue>): Record<string, TransferReference> {
        return Object.fromEntries([...this.transfers].filter(([name, transfer]) => JSON.stringify(values[name]) === JSON.stringify(transfer.value))
            .map(([name, transfer]) => [name, { sessionId: transfer.sessionId, id: transfer.id }]));
    }
    private readCapture(): Promise<ContentCapture> {
        return this.capture ??= this.commands.execute<ContentCapture>(ContentTransferCommand.Capture, { sessionId: this.sessionId })
            .catch(error => { this.capture = undefined; throw error; });
    }
    private bind(field: FlowParameter, input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, transfer: ContentTransfer): void {
        if (field.type !== 'json' && typeof transfer.value !== field.type)
            throw new Error(t('flow.source.typeMismatch'));
        if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = transfer.value === true;
        else {
            const value = typeof transfer.value === 'string' && field.type !== 'json' && !input.hasAttribute('data-parameter-enum') ? transfer.value : JSON.stringify(transfer.value);
            if (input instanceof HTMLSelectElement && ![...input.options].some(option => option.value === value)) throw new Error(t('flow.source.typeMismatch'));
            input.value = value;
        }
        this.transfers.set(field.name, transfer);
    }
}

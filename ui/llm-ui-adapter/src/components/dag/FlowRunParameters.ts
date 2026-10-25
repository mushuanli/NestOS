import { escapeHTML, t } from '@itookit/common';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { flowConnectionSelection } from '../../flows/connection-selection';
import type { FlowRunInput } from '../../flows/run-flow';
import { bindFlowImageFields } from '../FlowImageFields';
import {bindFlowFileFields} from '../FlowFileFields';
import {bindFlowParameterState, flowParameterFields, readFlowParameterForm, showFlowFieldError, validateFlowConnectionForm, type FlowConnectionSelection} from '../FlowParameterForm';
import {updateFlowConnectionRequirements} from '../FlowConnectionFields';

/** Keep form DOM alive while the canvas and node inspector are redrawn. */
export class FlowRunParameters {
    readonly root = document.createElement('div');
    readonly key: string;
    private disposed = false;
    private readonly lifetime = new AbortController();
    private connection?: FlowConnectionSelection;
    private imagesReady?: () => Promise<void> | undefined;
    private unbindFields?: () => void;
    private ready: Promise<void>;

    constructor(private readonly draft: FlowDraft, private readonly commands: ICommandBus) {
        this.key = FlowRunParameters.keyFor(draft);
        this.root.className = 'dag-run-parameters';
        this.root.setAttribute('role', 'region'); this.root.setAttribute('aria-label', t('flow.parameters.title'));
        this.root.innerHTML = `<p data-form-status class="dag-run-parameters__status" role="status"></p>
            <p data-form-error class="dag-dialog__error" role="alert"></p>
            <form novalidate><fieldset disabled data-run-fields></fieldset></form>
            <button type="button" data-retry hidden>${escapeHTML(t('flow.parameters.retry'))}</button>`;
        this.root.querySelector('form')!.addEventListener('submit', event => event.preventDefault());
        this.root.querySelector('[data-retry]')!.addEventListener('click', () => { this.ready = this.load(); });
        this.ready = this.load();
    }

    static keyFor(draft: FlowDraft): string {
        return JSON.stringify([draft.id, draft.parameters ?? [], draft.connections ?? [], draft.inputGroups ?? []]);
    }

    private async load(): Promise<void> {
        this.showError('');
        const status = this.root.querySelector('[data-form-status]')!;
        status.textContent = t('flow.parameters.loading');
        this.root.querySelector<HTMLButtonElement>('[data-retry]')!.hidden = true;
        try {
            const connection = await flowConnectionSelection(this.commands, undefined, this.draft.connections, undefined, this.draft);
            if (this.disposed) return;
            this.connection = connection;
            const fields = this.root.querySelector<HTMLFieldSetElement>('[data-run-fields]')!;
            this.unbindFields?.();
            fields.innerHTML = flowParameterFields(this.draft.parameters ?? [], connection, this.draft.inputGroups);
            fields.disabled = false;
            this.unbindFields = bindFlowParameterState(this.root, this.draft.parameters ?? [], this.draft.inputGroups ?? [], values => {
                updateFlowConnectionRequirements(this.root, connection, values);
            });
            const images = bindFlowImageFields(this.root, this.draft.parameters ?? [], connection.assets);
            const files = bindFlowFileFields(this.root, this.draft.parameters ?? [], connection.assets);
            this.imagesReady = () => {
                const pending = [images(), files()].filter((task): task is Promise<void> => task !== undefined);
                return pending.length ? Promise.all(pending).then(() => {}) : undefined;
            };
            this.showError('');
        } catch (error) {
            if (this.disposed) return;
            this.showError(error);
            this.root.querySelector<HTMLButtonElement>('[data-retry]')!.hidden = false;
        } finally {
            status.textContent = '';
        }
    }

    async read(): Promise<FlowRunInput | null> {
        await this.ready;
        if (this.disposed || !this.connection) return null;
        try {
            await this.imagesReady?.();
            if (this.disposed) return null;
            const parameters = readFlowParameterForm(this.root, this.draft.parameters ?? [], this.connection);
            await validateFlowConnectionForm(this.root, this.connection, parameters);
            if (this.disposed) return null;
            this.showError('');
            return { parameters, connection: snapshotConnection(this.connection), signal: this.lifetime.signal };
        } catch (error) {
            this.showError(error);
            this.root.scrollTop = 0;
            showFlowFieldError(this.root, error);
            return null;
        }
    }

    showError(error: unknown): void {
        if (!this.disposed) this.root.querySelector('[data-form-error]')!.textContent = error instanceof Error ? error.message : String(error);
    }

    destroy(): void {
        this.disposed = true;
        this.lifetime.abort();
        this.unbindFields?.();
        this.root.dispatchEvent(new Event('close'));
        this.root.remove();
    }
}

function snapshotConnection(connection: FlowConnectionSelection): FlowConnectionSelection {
    return { ...connection, bindings: { ...connection.bindings }, onChange: () => {} };
}

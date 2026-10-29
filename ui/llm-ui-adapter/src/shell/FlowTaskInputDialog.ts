import {createModuleLogger} from '@itookit/common';
import {taskInputParameters} from '../flows/task-input-parameters';
import type {InteractionRequest, JsonValue} from '@itookit/durable-kernel/contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import {promptFlowParameters} from '../components/FlowParameterForm';
import {flowInputAssets} from '../flows/input-assets';
import type {RunAttachmentController} from './RunAttachmentController';

/** Reuse the original Flow form while keeping the captured task attachment authoritative. */
export class FlowTaskInputDialog {
    private abort?: AbortController;
    private key?: string;
    constructor(private readonly commands: ICommandBus, private readonly failed: (error: unknown) => void, private readonly accepted: () => void) {}
    show(request: InteractionRequest<JsonValue>, attachment: RunAttachmentController, current: () => boolean): boolean {
        const parameters = taskInputParameters(request);
        if (!parameters) return false;
        const revision = attachment.revision, key = `${revision}:${request.id}`;
        if (this.key === key) return true;
        this.close(); this.key = key; const abort = this.abort = new AbortController();
        const binding = {attachment, revision, key, current, signal: abort.signal};
        void promptFlowParameters(parameters, request.prompt, values => this.respond(request.id, values, binding),
            abort.signal, undefined, flowInputAssets(this.commands), undefined, {submitLabel: 'flow.editor.submit'})
            .catch(this.failed).finally(() => {if (this.abort === abort) {this.key = undefined; this.abort = undefined;}});
        return true;
    }
    private async respond(id: string, values: Record<string, JsonValue>, binding: {
        attachment: RunAttachmentController; revision: number; key: string; current(): boolean; signal: AbortSignal;
    }): Promise<void> {
        const started = Date.now(), log = createModuleLogger('flow-input');
        try {
            if (binding.signal.aborted || !binding.current() || binding.attachment.revision !== binding.revision)
                throw Object.assign(new Error('Task interaction binding expired'), {code: 'STALE_INTERACTION'});
            await binding.attachment.respondInput(id, values, binding.revision);
            log.info('flow.input.respond', {operationId: binding.key, stage: 'respond', result: 'accepted', durationMs: Date.now() - started});
            if (this.key === binding.key) this.accepted();
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            log.warn('flow.input.respond', {operationId: binding.key, stage: 'respond', result: 'failure',
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'FLOW_INPUT_RESPONSE_FAILED', durationMs: Date.now() - started});
            throw error;
        }
    }
    close(): void {this.abort?.abort(); this.abort = undefined; this.key = undefined;}
}

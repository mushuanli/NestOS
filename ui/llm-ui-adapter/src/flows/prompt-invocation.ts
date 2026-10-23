import { escapeHTML, randomUUID, t } from '@itookit/common';
import { ContentTransferCommand, FlowInvocationCommand, type ICommandBus } from '@itookit/llm-session/contracts';
import type { FlowParameter, FlowRevision, JsonValue } from '@itookit/llm-flow/contracts';
import { promptFlowParameters, type FlowConnectionSelection } from '../components/FlowParameterForm';
import { FlowInputSources } from './flow-input-sources';
import { contentSourceError } from './content-source-picker';

export interface InvocationPromptOptions {
    commands: ICommandBus; sessionId: string; name: string; fields: FlowParameter[];
    connection: FlowConnectionSelection; signal?: AbortSignal; revision(): Promise<FlowRevision>;
    openChild?(id: string): void | Promise<void>;
}

/** Slash and repeat share typed inputs, explicit sources and one durable admission protocol. */
export function promptInvocation(options: InvocationPromptOptions): Promise<boolean> {
    return new InvocationLaunch(options).open();
}

class InvocationLaunch {
    private readonly sources: FlowInputSources;
    private requests = new Map<string, string>();
    private child = false;
    private openedChild?: string;
    constructor(private readonly options: InvocationPromptOptions) {
        this.sources = new FlowInputSources(options.commands, options.sessionId, options.fields);
    }
    async open(): Promise<boolean> {
        const options = this.options;
        const values = await promptFlowParameters(options.fields, `${t('flow.invoke.title')} · ${options.name}`,
            (values, signal) => this.submit(values, signal), options.signal, options.connection, options.connection.assets, t('flow.source.description'),
            {validate: () => this.sources.validate(), mount: root => this.mount(root), formatError: contentSourceError, submitLabel: 'flow.source.start', withSubmissionSignal: true});
        if (this.openedChild && !options.signal?.aborted) await options.openChild?.(this.openedChild);
        return values !== null;
    }
    private mount(root: HTMLElement): () => void {
        const dispose = this.sources.mount(root), location = document.createElement('label');
        location.className = 'flow-launch-location';
        location.innerHTML = `${escapeHTML(t('flow.source.location'))}<select><option value="current">${escapeHTML(t('flow.source.current'))}</option>
            <option value="child">${escapeHTML(t('flow.source.child'))}</option></select>`;
        root.querySelector('.flow-parameter-dialog__body')!.prepend(location);
        location.querySelector('select')!.addEventListener('change', event => { this.child = (event.target as HTMLSelectElement).value === 'child'; });
        return () => { dispose(); location.remove(); };
    }
    private async submit(parameters: Record<string, JsonValue>, signal?: AbortSignal): Promise<void> {
        const options = this.options;
        options.signal?.throwIfAborted(); signal?.throwIfAborted();
        // Freeze every choice before the first asynchronous admission step.
        const inputSources = this.sources.bindings(parameters), child = this.child;
        const connection = structuredClone({selected: options.connection.selected, bindings: options.connection.bindings});
        const key = JSON.stringify([parameters, inputSources, child, connection]);
        const requestId = this.requests.get(key) ?? randomUUID(); this.requests.set(key, requestId);
        const revision = await options.revision();
        options.signal?.throwIfAborted(); signal?.throwIfAborted();
        let sessionId = options.sessionId;
        if (child) sessionId = (await options.commands.execute<{ sessionId: string }>(ContentTransferCommand.CreateChild,
            { sessionId, requestId, title: options.name })).sessionId;
        options.signal?.throwIfAborted(); signal?.throwIfAborted();
        await options.commands.execute(FlowInvocationCommand.Invoke, { sessionId, requestId, flowId: revision.id, revision: revision.revision,
            parameters, ...(Object.keys(inputSources).length ? { inputSources } : {}), connectionId: connection.selected,
            ...(Object.keys(connection.bindings ?? {}).length ? { connectionBindings: connection.bindings } : {}) });
        if (child) this.openedChild = sessionId;
    }
}

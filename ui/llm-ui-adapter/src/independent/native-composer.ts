import {composeCommandCatalogs, type CommandCatalog, type CommandDefinition, type CommandSource, type CommandSubmission,
    type ComposerCommand, type SelectorView, type OperationContext, type OperationReceipt} from '@itookit/llm-ui';
import type {ConversationControls, ConversationModelCatalog, ConversationModelSelection, ConversationSnapshot, ConversationSlashCommand} from '@itookit/ui-common';
import {t} from '@itookit/common';

/** Hosts register UI, project, Flow or Agent contributions without exposing their services. */
export interface NativeCommandProvider {
    readonly source: CommandSource;
    commands(snapshot: ConversationSnapshot): readonly CommandDefinition[];
    execute(input: CommandSubmission, context: OperationContext): Promise<OperationReceipt>;
    subscribe?(listener: () => void): () => void;
}

/** Native metadata is scoped to a binding; it is not a local LLMConnection. */
export class NativeComposerCapabilities {
    private key?: string;
    private scope?: string;
    private pending?: Promise<boolean>;
    private generation = 0;
    private commandRevision = 0;
    private retryAt = 0;
    private failures = 0;
    private models: ConversationModelCatalog = {models: []};
    private commands: ConversationSlashCommand[] = [];
    constructor(private readonly controls: ConversationControls, private readonly report?: (error: unknown) => void) {}
    load(state: ConversationSnapshot, force = false): Promise<boolean> {
        const scope = JSON.stringify([state.sessionId, state.supportsModels, state.supportsSlashCommands, state.observation?.scope]);
        const key = JSON.stringify([scope, state.slashCommands, state.commandCatalogObservation]);
        if (!force && key === this.key && (this.pending || Date.now() < this.retryAt || !this.failures)) return this.pending ?? Promise.resolve(false);
        if (scope !== this.scope) {this.models = {models: []}; this.commands = []; this.failures = 0; this.retryAt = 0; ++this.commandRevision;}
        this.scope = scope; this.key = key; const generation = ++this.generation;
        const work = this.read(state).then(([models, commands]) => {
            if (generation !== this.generation) return false;
            if (models.status === 'fulfilled') this.models = models.value;
            else this.report?.(models.reason);
            if (commands.status === 'fulfilled') this.setCommands(commands.value);
            else this.report?.(commands.reason);
            this.failures = models.status === 'rejected' || commands.status === 'rejected' ? this.failures + 1 : 0;
            this.retryAt = this.failures ? Date.now() + Math.min(15000, 1000 * 2 ** Math.min(this.failures - 1, 4)) : 0;
            return true;
        }).finally(() => {if (this.pending === work) this.pending = undefined;});
        this.pending = work; return work;
    }
    private setCommands(commands: ConversationSlashCommand[]): void {
        if (JSON.stringify(this.commands) !== JSON.stringify(commands)) ++this.commandRevision;
        this.commands = commands;
    }
    async refreshCommands(state: ConversationSnapshot): Promise<void> {
        const generation = this.generation;
        const commands = state.supportsSlashCommands && this.controls.commands ? await this.controls.commands() : [];
        if (generation === this.generation) this.setCommands(commands);
    }
    private read(state: ConversationSnapshot) {
        return Promise.allSettled([
            state.supportsModels && this.controls.models ? this.controls.models() : Promise.resolve({models: []}),
            state.supportsSlashCommands && this.controls.commands ? this.controls.commands() : Promise.resolve([]),
        ] as const);
    }
    selectors(): readonly SelectorView[] | undefined {
        if (!this.models.models.length) return;
        const auto = {id: '', label: t('chatSettings.followDefault')};
        return [{id: 'modelId', label: t('chatInput.model'), value: '', choices: [
            {id: '', label: t('harness.followNativeSettings')}, ...this.models.models.map(model => ({id: model.id, label: model.label}))]},
        {id: 'reasoningEffort', label: t('harness.reasoning'), value: '', choices: [auto],
            variants: {selectorId: 'modelId', values: Object.fromEntries(this.models.models.map(model => [model.id,
                {value: '', choices: [auto, ...model.reasoningEfforts.map(effort => ({id: effort.id, label: effort.label}))]}]))}}];
    }
    catalog(state: ConversationSnapshot): CommandCatalog {
        return {source: {id: 'harness', label: t('harness.remoteAgents')}, commands: this.commands.map(command => ({
            id: command.name, revision: this.commandRevision, name: command.name, description: command.description,
            argumentHint: command.argumentHint, kind: command.kind,
            execution: command.execution,
            disabled: !!command.disabled || !(command.execution === 'query' && state.canQueryCommand ? this.controls.queryCommand : this.controls.command) || !this.available(command, state)}))};
    }
    resolve(name: string): ConversationSlashCommand | undefined {
        const command = this.commands.find(command => command.name === name);
        return command ? {...command} : undefined;
    }
    private available(command: ConversationSlashCommand, state: ConversationSnapshot): boolean {
        if (command.execution === 'query') return !!(state.canQueryCommand && this.controls.queryCommand) || (state.canCommand ?? state.canSend) && !state.pending;
        return !!(state.canQueue && this.controls.enqueue) || state.canSend && !state.pending;
    }
    compose(state: ConversationSnapshot, contributions: readonly CommandCatalog[] = []): readonly ComposerCommand[] {
        return composeCommandCatalogs([...contributions, this.catalog(state)]);
    }
    selection(values?: Readonly<Record<string, string>>): ConversationModelSelection | undefined {
        if (!values?.modelId) {
            if (values?.reasoningEffort) throw new Error('Model selection is required');
            return;
        }
        const model = this.models.models.find(model => model.id === values.modelId);
        if (!model || values.reasoningEffort && !model.reasoningEfforts.some(effort => effort.id === values.reasoningEffort))
            throw new Error('Native model or reasoning effort unavailable');
        return {modelId: model.id, ...(values.reasoningEffort ? {reasoningEffort: values.reasoningEffort} : {})};
    }
    dispose(): void {++this.generation;}
}

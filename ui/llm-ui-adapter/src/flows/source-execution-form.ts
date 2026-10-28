import {InputSourceCommand, type ExecutableInputSource} from '@itookit/app-contracts';
import {FlowCommand, type FlowRevision} from '@itookit/llm-flow/contracts';
import {SessionCommand, type ICommandBus, type RootTargetCatalog, type ToolCommandOption} from '@itookit/llm-session/contracts';
import {promptToolCall} from './tool-call-form';
import {promptFlowParameters} from '../components/FlowParameterForm';
import {flowConnectionSelection} from './connection-selection';
import {t} from '@itookit/common';

export async function sourceExecutionForm(commands: ICommandBus, kind: 'tool' | 'mcp' | 'flow', signal: AbortSignal): Promise<ExecutableInputSource | null> {
    if (kind !== 'flow') {
        const tools = await commands.execute<ToolCommandOption[]>(InputSourceCommand.Catalog);
        const value = await promptToolCall(tools, {signal, mcpOnly: kind === 'mcp'});
        return value ? {kind: 'tool', ...value} : null;
    }
    const catalog = await commands.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const choices = catalog.entries.filter(entry => entry.target.kind === 'flow');
    const selected = await promptFlowParameters([{name: 'flow', type: 'string', required: true, widget: 'select', options: choices.map(entry => entry.target.id),
        label: t('flow.source.flow'), description: choices.map(entry => `${entry.target.id}: ${entry.name}`).join('\n')}], t('flow.source.flow'), undefined, signal);
    if (!selected || signal.aborted) return null;
    const target = choices.find(entry => entry.target.id === selected.flow)?.target;
    if (!target) throw new Error(t('callable.catalog.changed'));
    const flow = await commands.execute<FlowRevision>(FlowCommand.RevisionGet, {id: target.id, revision: Number(target.version)});
    if (!flow || flow.digest !== target.digest) throw new Error(t('callable.catalog.changed'));
    const connection = await flowConnectionSelection(commands, undefined, flow.connections, undefined, flow);
    const parameters = await promptFlowParameters(flow.parameters ?? [], flow.name, undefined, signal, connection);
    return parameters && !signal.aborted ? {kind: 'flow', flowId: flow.id, revision: flow.revision, digest: flow.digest, parameters,
        connectionId: connection.selected, connectionBindings: connection.bindings} : null;
}

import { randomUUID, t } from '@itookit/common';
import { ContentTransferCommand, type ContentTransfer, type ICommandBus } from '@itookit/llm-session/contracts';
import { promptFlowParameters } from '../components/FlowParameterForm';
import { FlowInputSources } from './flow-input-sources';
import { contentSourceError } from './content-source-picker';

export async function promptChildConversation(commands: ICommandBus, sessionId: string, signal: AbortSignal): Promise<string | null> {
    const fields = [{name: 'title', type: 'string' as const, label: t('project.childTitle'), required: true, default: t('project.childName', {count: 1})},
        {name: 'material', type: 'string' as const, label: t('project.childMaterial')}];
    const sources = new FlowInputSources(commands, sessionId, fields, ['material']);
    const requests = new Map<string, string>(), materials = new Map<string, {sessionId: string; id: string}>(); let created: string | null = null;
    const extension = {validate: () => sources.validate(), formatError: contentSourceError, withSubmissionSignal: true, submitLabel: 'project.childCreate' as const,
        mount: (root: HTMLElement) => sources.mount(root)};
    await promptFlowParameters(fields, t('project.childCreate'), async (values, dialogSignal) => {
        signal.throwIfAborted(); dialogSignal?.throwIfAborted();
        const title = String(values.title);
        const bindings = sources.bindings(values);
        let transfer = bindings.material ?? materials.get(String(values.material ?? ''));
        if (!transfer && typeof values.material === 'string' && values.material.trim()) {
            const capture = await commands.execute<{id: string}>(ContentTransferCommand.Capture, {sessionId});
            const saved = await commands.execute<ContentTransfer>(ContentTransferCommand.Resolve, {sessionId, captureId: capture.id,
                selection: {kind: 'text', text: values.material}});
            transfer = {sessionId, id: saved.id}; materials.set(String(values.material), transfer);
        }
        const key = JSON.stringify([title, transfer]), requestId = requests.get(key) ?? randomUUID(); requests.set(key, requestId);
        signal.throwIfAborted(); dialogSignal?.throwIfAborted();
        const result = await commands.execute<{sessionId: string}>(ContentTransferCommand.CreateChild,
            {sessionId, requestId, title, ...(transfer ? {transfer} : {})});
        created = result.sessionId;
    }, signal, undefined, undefined, t('project.childContextHint'), extension);
    return created;
}

import { flowConnectionSelection } from './connection-selection';
import { escapeHTML, randomUUID, t } from '@itookit/common';
import { type FlowDraft, type FlowRevision, type JsonValue } from '@itookit/llm-flow/contracts';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { FlowInvocationCommand } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { promptFlowParameters } from '../components/FlowParameterForm';

/** Slash calls leave the Session's ordinary chat execution mode untouched. */
export async function invokeFlowText(commands: ICommandBus, sessionId: string, text: string, signal?: AbortSignal): Promise<boolean> {
    const match = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const drafts = await commands.execute<FlowDraft[]>(FlowCommand.DraftList);
    const id = match?.[1] ?? await pickFlow(drafts, signal);
    if (!id || signal?.aborted) return false;
    const draft = await commands.execute<FlowDraft | null>(FlowCommand.DraftLoad, { id });
    if (!draft) throw new Error(t('flow.launch.invalid'));
    const provided = parseArguments(match?.[2]), fields = draft.parameters ?? [];
    for (const name of Object.keys(provided)) if (!fields.some(field => field.name === name)) throw new Error(t('flow.invoke.unknownParameter', { name }));
    const connection = await flowConnectionSelection(commands);
    const requests = new Map<string, string>();
    let revision: FlowRevision | undefined;
    const submit = async (parameters: Record<string, JsonValue>) => {
        if (signal?.aborted) throw new Error(t('flow.launch.cancel'));
        revision ??= (await commands.execute<{ revision: FlowRevision }>(FlowCommand.RevisionCreate, { draftId: id, expectedDraftVersion: draft.draftVersion })).revision;
        if (signal?.aborted) throw new Error(t('flow.launch.cancel'));
        const key = JSON.stringify([parameters, connection.selected]), requestId = requests.get(key) ?? randomUUID(); requests.set(key, requestId);
        await commands.execute(FlowInvocationCommand.Invoke, { sessionId, requestId, flowId: id, revision: revision.revision, parameters, connectionId: connection.selected });
    };
    return await promptFlowParameters(fields.map(field => ({ ...field, ...(Object.hasOwn(provided, field.name) ? { default: provided[field.name] } : {}) })),
        `${t('flow.invoke.title')} · ${draft.name}`, submit, signal, connection) !== null;
}

function parseArguments(text?: string): Record<string, JsonValue> {
    if (!text?.trim()) return {};
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(t('flow.invoke.arguments'));
    return value;
}

function pickFlow(drafts: FlowDraft[], signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
        const dialog = document.createElement('dialog'); dialog.className = 'dag-dialog';
        dialog.innerHTML = `<form method="dialog"><h2>${escapeHTML(t('flow.invoke.title'))}</h2><select data-flow>${drafts.map(flow =>
            `<option value="${escapeHTML(String(flow.id))}">${escapeHTML(flow.name)} · ${escapeHTML(String(flow.id))}</option>`).join('')}</select>
            <p>${escapeHTML(t('flow.invoke.arguments'))}</p><menu><button value="cancel">${escapeHTML(t('flow.launch.cancel'))}</button>
            <button value="run" ${drafts.length ? '' : 'disabled'}>${escapeHTML(t('flow.invoke.run'))}</button></menu></form>`;
        const abort = () => dialog.close();
        signal?.addEventListener('abort', abort, { once: true });
        dialog.addEventListener('close', () => {
            const selected = dialog.returnValue === 'run' && !signal?.aborted ? dialog.querySelector<HTMLSelectElement>('[data-flow]')!.value : null;
            signal?.removeEventListener('abort', abort); dialog.remove(); resolve(selected);
        }, { once: true });
        document.body.append(dialog); dialog.showModal();
    });
}

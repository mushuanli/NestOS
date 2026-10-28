import {resolveFlowArguments} from './flow-arguments';
import type {OperationLedger} from '@itookit/llm-ui';
import { flowConnectionSelection } from './connection-selection';
import { escapeHTML, t } from '@itookit/common';
import { type FlowRevision } from '@itookit/llm-flow/contracts';
import {SessionCommand, type RootCallTarget, type RootTargetCatalog, type ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { promptInvocation } from './prompt-invocation';

/** Slash calls leave the Session's ordinary chat execution mode untouched. */
export async function invokeFlowText(commands: ICommandBus, sessionId: string, text: string, signal?: AbortSignal, openChild?: (id: string) => void | Promise<void>, operations?: OperationLedger): Promise<boolean> {
    const match = text.trim().match(/^("(?:\\.|[^"\\])*"|\S+)(?:\s+([\s\S]*))?$/);
    const catalog = await commands.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const flows = catalog.entries.filter(entry => entry.target.kind === 'flow');
    const id = match?.[1] ?? await pickFlow(flows, signal);
    if (!id || signal?.aborted) return false;
    const name = id.startsWith('"') ? JSON.parse(id) : id;
    const matches = flows.filter(flow => flow.target.id === name || flow.name === name);
    const choice = matches.length === 1 ? matches[0] : undefined;
    if (!choice) throw new Error(t('flow.launch.invalid'));
    const revision = await commands.execute<FlowRevision | null>(FlowCommand.RevisionGet, {id: choice.target.id, revision: Number(choice.target.version)});
    if (!revision || revision.digest !== choice.target.digest) throw new Error(t('callable.catalog.changed'));
    const fields = revision.parameters ?? [];
    const provided = await resolveFlowArguments(match?.[2] ?? '', fields, commands, {navigation: 'projects', sessionId}, signal);
    for (const name of Object.keys(provided)) if (!fields.some(field => field.name === name)) throw new Error(t('flow.invoke.unknownParameter', { name }));
    const connection = await flowConnectionSelection(commands, undefined, revision.connections, undefined, revision);
    return promptInvocation({ commands, sessionId, name: choice.name, connection, signal, openChild, operations,
        fields: fields.map(field => ({ ...field, ...(Object.hasOwn(provided, field.name) ? { default: provided[field.name] } : {}) })),
        revision: async () => revision });
}

function pickFlow(drafts: RootCallTarget[], signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
        const dialog = document.createElement('dialog'); dialog.className = 'dag-dialog';
        dialog.innerHTML = `<form method="dialog"><h2>${escapeHTML(t('flow.invoke.title'))}</h2><select data-flow><option value="">${escapeHTML(t('flow.invoke.none'))}</option>${drafts.map(flow =>
            `<option value="${escapeHTML(flow.target.id)}">${escapeHTML(flow.name)}</option>`).join('')}</select>
            <p>${escapeHTML(t('flow.invoke.arguments'))}</p><menu><button value="cancel">${escapeHTML(t('flow.launch.cancel'))}</button>
            <button value="run" disabled>${escapeHTML(t('flow.invoke.run'))}</button></menu></form>`;
        const select = dialog.querySelector<HTMLSelectElement>('[data-flow]')!;
        const run = dialog.querySelector<HTMLButtonElement>('[value="run"]')!;
        select.onchange = () => {run.disabled = !select.value;};
        const abort = () => dialog.close();
        signal?.addEventListener('abort', abort, { once: true });
        dialog.addEventListener('close', () => {
            const selected = dialog.returnValue === 'run' && !signal?.aborted ? dialog.querySelector<HTMLSelectElement>('[data-flow]')!.value : null;
            signal?.removeEventListener('abort', abort); dialog.remove(); resolve(selected);
        }, { once: true });
        document.body.append(dialog); dialog.showModal();
    });
}

import { escapeHTML, t } from '@itookit/common';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand, type FlowTaskTranscript } from '@itookit/llm-flow/contracts';

/** Interactive pages stay bounded; export re-reads the pinned version on demand. */
const PAGE_BYTES = 256 * 1024;
/** Guard against an unbounded export loop on a corrupt `nextOffset` chain. */
const MAX_EXPORT_EFFECTS = 10_000;

export function openTaskTranscript(commands: ICommandBus, sessionId: string, taskId: string, targetTaskId: string): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'dag-dialog dag-transcript';
    dialog.innerHTML = `<form method="dialog"><h2>${escapeHTML(t('flow.transcript.title'))}</h2>
        <p data-status role="status">${escapeHTML(t('status.loading'))}</p>
        <pre data-transcript></pre><menu>
        <button type="button" data-more hidden>${escapeHTML(t('flow.transcript.more'))}</button>
        <button type="button" data-export disabled>${escapeHTML(t('flow.transcript.export'))}</button>
        <button type="button" data-export-text disabled>${escapeHTML(t('flow.transcript.exportText'))}</button>
        <button value="close">${escapeHTML(t('flow.transcript.close'))}</button></menu></form>`;
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    void loadTranscript(dialog, commands, { sessionId, taskId, targetTaskId });
}

interface TranscriptArgs { sessionId: string; taskId: string; targetTaskId: string }

async function loadTranscript(dialog: HTMLDialogElement, commands: ICommandBus,
    args: TranscriptArgs, previous?: FlowTaskTranscript): Promise<void> {
    const more = dialog.querySelector<HTMLButtonElement>('[data-more]')!;
    more.disabled = true;
    setExportEnabled(dialog, false);
    try {
        const page = await commands.execute<FlowTaskTranscript>(FlowCommand.RunTranscript, {
            ...args,
            query: {
                ...(previous ? { version: previous.version, offset: previous.nextOffset } : {}),
                maxBytes: PAGE_BYTES,
            },
        });
        const transcript = previous ? { ...page, effects: [...previous.effects, ...page.effects],
            truncated: Boolean(previous.truncated || page.truncated), bytes: previous.bytes + page.bytes } : page;
        if (!dialog.isConnected) return;
        dialog.querySelector('[data-status]')!.textContent = statusText(transcript);
        dialog.querySelector('[data-transcript]')!.textContent = transcriptText(transcript);
        // Export does not require paging through every exchange: it re-reads the complete
        // version itself, so the visible page stays bounded while the file stays lossless.
        const button = dialog.querySelector<HTMLButtonElement>('[data-export]')!;
        button.disabled = false;
        button.onclick = () => void exportTranscript(dialog, commands, args, transcript, 'json');
        const textButton = dialog.querySelector<HTMLButtonElement>('[data-export-text]')!;
        textButton.disabled = false;
        textButton.onclick = () => void exportTranscript(dialog, commands, args, transcript, 'txt');
        more.hidden = transcript.nextOffset === undefined;
        more.onclick = () => void loadTranscript(dialog, commands, args, transcript);
    } catch (error) {
        if (dialog.isConnected) dialog.querySelector('[data-status]')!.textContent = errorText(error);
    } finally { more.disabled = false; }
}

/** Fetch every exchange of the reviewed version, then hand the file to the browser. */
async function exportTranscript(dialog: HTMLDialogElement, commands: ICommandBus,
    args: TranscriptArgs, visible: FlowTaskTranscript, format: 'json' | 'txt'): Promise<void> {
    const status = dialog.querySelector('[data-status]')!;
    const restore = status.textContent;
    setExportEnabled(dialog, false);
    dialog.querySelector<HTMLButtonElement>('[data-more]')!.disabled = true;
    status.textContent = t('status.loading');
    try {
        const complete = await readCompleteTranscript(commands, args, visible.version, () => dialog.isConnected);
        if (!dialog.isConnected) return;
        downloadTranscript(complete, format);
        status.textContent = restore;
    } catch (error) {
        if (dialog.isConnected) status.textContent = errorText(error);
    } finally {
        if (dialog.isConnected) {
            setExportEnabled(dialog, true);
            dialog.querySelector<HTMLButtonElement>('[data-more]')!.disabled = false;
        }
    }
}

function setExportEnabled(dialog: HTMLDialogElement, enabled: boolean): void {
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-export],[data-export-text]')) {
        button.disabled = !enabled;
    }
}

async function readCompleteTranscript(commands: ICommandBus, args: TranscriptArgs, version: number, isOpen: () => boolean): Promise<FlowTaskTranscript> {
    let complete: FlowTaskTranscript | undefined;
    let offset = 0;
    for (;;) {
        if (!isOpen()) throw new Error(t('flow.transcript.failed'));
        const page = await commands.execute<FlowTaskTranscript>(FlowCommand.RunTranscript, { ...args, query: { version, offset } });
        assertExportPage(page, args, version, offset);
        complete = complete ? { ...page, effects: [...complete.effects, ...page.effects] } : page;
        if (complete.effects.length > MAX_EXPORT_EFFECTS) throw new Error(t('flow.transcript.failed'));
        if (page.nextOffset === undefined) return complete;
        offset = page.nextOffset;
    }
}

/** Never label truncated data or mixed identities/versions as a complete export. */
function assertExportPage(page: FlowTaskTranscript, args: TranscriptArgs, version: number, offset: number): void {
    const next = page.nextOffset;
    if (page.sessionId !== args.sessionId || page.runTaskId !== args.taskId || page.taskId !== args.targetTaskId
        || page.version !== version || page.truncated
        || (next !== undefined && (!Number.isSafeInteger(next) || next <= offset || !page.effects.length))) {
        throw new Error(t('flow.transcript.failed'));
    }
}

function statusText(transcript: FlowTaskTranscript): string {
    const identity = `${transcript.nodeId ?? transcript.taskId} · ${transcript.status} · v${transcript.version}`;
    return transcript.truncated
        ? `${identity} · ${t('flow.transcript.truncated')} (${transcript.bytes} B)`
        : identity;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : t('flow.transcript.failed');

/** Show each recorded exchange separately; do not deduplicate away repeated or compacted context. */
export function transcriptText(transcript: FlowTaskTranscript): string {
    const sections = [
        `${t('flow.transcript.input')}\n${JSON.stringify(transcript.input, null, 2)}`,
        ...transcript.effects.map(effect => `${effect.request.kind} · ${effect.effectId} · ${effect.status}\n${JSON.stringify(effect, null, 2)}`),
        `${t('flow.transcript.interactions')}\n${JSON.stringify(transcript.interactions, null, 2)}`,
        `${t('flow.transcript.output')}\n${JSON.stringify(transcript.output ?? null, null, 2)}`,
    ];
    return sections.join('\n\n────────────────────\n\n');
}

function downloadTranscript(transcript: FlowTaskTranscript, format: 'json' | 'txt'): void {
    const content = format === 'json' ? JSON.stringify(transcript, null, 2) : exportTranscriptText(transcript);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transcript-${transcript.taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${format}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Include snapshot identity in standalone text exports as well as every recorded exchange. */
function exportTranscriptText(transcript: FlowTaskTranscript): string {
    const identity = { sessionId: transcript.sessionId, runTaskId: transcript.runTaskId,
        taskId: transcript.taskId, nodeId: transcript.nodeId, status: transcript.status,
        version: transcript.version, totalEffects: transcript.totalEffects ?? transcript.effects.length };
    return `${JSON.stringify(identity, null, 2)}\n\n${transcriptText(transcript)}\n`;
}

import { escapeHTML, t } from '@itookit/common';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';

interface RunSummary { taskId: string; sessionId: string; name: string; status: string; createdAt: number }

export function openRunPicker(commands: ICommandBus, select: (run: RunSummary) => Promise<void>): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'dag-dialog';
    dialog.innerHTML = `<form method="dialog"><h2>${escapeHTML(t('flow.runs.title'))}</h2>
        <div data-runs role="status">${escapeHTML(t('status.loading'))}</div>
        <menu><button>${escapeHTML(t('flow.transcript.close'))}</button></menu></form>`;
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal();
    void loadRuns(dialog, commands, select);
}

async function loadRuns(dialog: HTMLDialogElement, commands: ICommandBus, select: (run: RunSummary) => Promise<void>): Promise<void> {
    const list = dialog.querySelector<HTMLElement>('[data-runs]')!;
    try {
        const runs = await commands.execute<RunSummary[]>(FlowCommand.RunList, {});
        if (!dialog.isConnected) return;
        list.innerHTML = runs.length ? runs.map((run, index) => `<p><button type="button" data-run-index="${index}">${escapeHTML(run.name)} · ${escapeHTML(run.status)} · ${escapeHTML(new Date(run.createdAt).toLocaleString())}</button></p>`).join('')
            : escapeHTML(t('flow.runs.empty'));
        list.addEventListener('click', event => {
            const button = (event.target as Element).closest<HTMLButtonElement>('[data-run-index]');
            if (!button || button.disabled) return;
            button.disabled = true;
            void select(runs[Number(button.dataset.runIndex)]).then(() => dialog.close(), error => {
                if (dialog.isConnected) { button.disabled = false; list.append(document.createTextNode(String(error))); }
            });
        });
    } catch (error) { if (dialog.isConnected) list.textContent = String(error); }
}

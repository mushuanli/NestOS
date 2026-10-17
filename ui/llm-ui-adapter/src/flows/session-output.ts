import { escapeHTML, t } from '@itookit/common';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { DagWorkbench } from '../components/DagWorkbench';

interface Branches { currentBranch: string; branches: Array<{ name: string; taskIds: string[]; runs?: Array<{ taskId: string; flowId: string; revision: number }> }> }

interface Run { taskId: string; sessionId: string; name: string; status: string }

/** A read-only attachment: opening outputs must never resume a stopped scheduler. */
export function openSessionFlowOutputs(commands: ICommandBus, sessionId: string, signal: AbortSignal): void {
    if (signal.aborted) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'dag-dialog dag-output-dialog';
    dialog.innerHTML = `<header><h2>${escapeHTML(t('flow.output.title'))}</h2><select data-branch aria-label="${escapeHTML(t('flow.output.branch'))}"></select><select data-run aria-label="${escapeHTML(t('flow.runs.title'))}"></select>
        <button data-refresh>${escapeHTML(t('flow.output.refresh'))}</button><button data-close>${escapeHTML(t('flow.transcript.close'))}</button></header>
        <p data-error role="status"></p><div class="dag-output-dialog__body"></div>`;
    const body = dialog.querySelector<HTMLElement>('.dag-output-dialog__body')!;
    const message = dialog.querySelector<HTMLElement>('[data-error]')!;
    const select = dialog.querySelector<HTMLSelectElement>('[data-run]')!;
    const branch = dialog.querySelector<HTMLSelectElement>('[data-branch]')!;
    let memberships: Branches = { currentBranch: '', branches: [] }, runs: Run[] = [];
    const workbench = new DagWorkbench(body, { commands, readOnly: true, backLabel: t('flow.transcript.close'),
        onModeChange: mode => { if (mode === 'design') dialog.close(); } });
    let revision = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => dialog.close();
    dialog.addEventListener('close', () => { revision++; clearTimeout(timer); workbench.destroy(); signal.removeEventListener('abort', close); dialog.remove(); }, { once: true });
    signal.addEventListener('abort', close, { once: true });
    dialog.querySelector('[data-close]')!.addEventListener('click', close);
    const open = async () => {
        if (!select.value || signal.aborted) return;
        try { await workbench.openRun(select.value, sessionId); }
        catch (error) { if (dialog.isConnected) message.textContent = String(error); }
    };
    const showBranch = async () => {
        workbench.destroy();
        const selected = memberships.branches.find(item => item.name === branch.value);
        const allowed = new Set(selected?.taskIds ?? []);
        const ownRuns = runs.filter(run => run.sessionId === sessionId && allowed.has(run.taskId)), previous = select.value;
        select.innerHTML = ownRuns.map(run => `<option value="${escapeHTML(run.taskId)}">${escapeHTML(run.name)}${escapeHTML(flowVersion(selected?.runs?.find(item => item.taskId === run.taskId)))} · ${escapeHTML(run.status)}</option>`).join('');
        if (ownRuns.some(run => run.taskId === previous)) select.value = previous;
        message.textContent = ownRuns.length ? '' : t('flow.runs.empty');
        await open();
    };
    const refresh = async () => {
        const current = ++revision; clearTimeout(timer);
        try {
            const [nextRuns, nextBranches] = await Promise.all([
                commands.execute<Run[]>(FlowCommand.RunList, { sessionId }),
                commands.execute<Branches>(SessionCommand.FlowBranchExecutions, { sessionId }),
            ]);
            if (current !== revision || signal.aborted || !dialog.isConnected) return;
            runs = nextRuns; memberships = nextBranches;
            const previous = branch.value || memberships.currentBranch;
            branch.innerHTML = memberships.branches.map(item => `<option value="${escapeHTML(item.name)}">${escapeHTML(item.name)}${escapeHTML([...new Set((item.runs ?? []).map(flowVersion))].join(''))}</option>`).join('');
            if (memberships.branches.some(item => item.name === previous)) branch.value = previous;
            await showBranch();
            if (current === revision && !select.value) timer = setTimeout(() => { void refresh(); }, 1000);
        } catch (error) { if (current === revision && dialog.isConnected) message.textContent = String(error); }
    };
    branch.addEventListener('change', () => {
        revision++; clearTimeout(timer);
        void showBranch().then(() => { if (!select.value && dialog.isConnected) timer = setTimeout(() => { void refresh(); }, 1000); });
    });
    select.addEventListener('change', () => { void open(); });
    dialog.querySelector('[data-refresh]')!.addEventListener('click', () => { void refresh(); });
    document.body.append(dialog); dialog.showModal(); void refresh();
}

function flowVersion(run?: { flowId: string; revision: number }): string {
    return run ? ` · ${run.flowId}@v${run.revision}` : '';
}

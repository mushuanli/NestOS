import {createModuleLogger, randomUUID, t} from '@itookit/common';
import {describeErrorReason, type DeleteResult} from '@itookit/vfs-ui';
import type {DrawerKind} from '@itookit/app-contracts';

interface Options {
    signal: AbortSignal;
    paths(kind: DrawerKind): string[];
    title(path: string): string;
    remove?(paths: string[], signal: AbortSignal): Promise<DeleteResult>;
    canRemove?(paths: string[]): boolean;
}
const log = createModuleLogger('toolbox-organize');

/** The organizer shares host deletion policy and freezes the selected paths before dispatch. */
export class OrganizeItems {
    readonly element = document.createElement('div');
    private readonly search = document.createElement('input');
    private readonly list = document.createElement('div');
    private readonly remove = document.createElement('button');
    private readonly status = document.createElement('p');
    private kind: DrawerKind = 'flows';
    private busy = false;
    constructor(private readonly options: Options) {
        this.search.type = 'search'; this.search.placeholder = t('toolbox.searchItems'); this.search.setAttribute('aria-label', this.search.placeholder);
        this.list.className = 'toolbox-organize-list'; this.status.className = 'toolbox-organize-status'; this.status.setAttribute('role', 'alert');
        const actions = document.createElement('div'), all = document.createElement('button');
        actions.className = 'toolbox-organize-actions'; all.type = 'button'; all.textContent = t('toolbox.selectAll');
        this.remove.type = 'button'; this.remove.dataset.action = 'delete-organized';
        this.remove.className = 'toolbox-organize-actions__delete';
        all.onclick = () => {const inputs = [...this.list.querySelectorAll<HTMLInputElement>('label:not([hidden]) input')];
            const checked = !inputs.every(input => input.checked); for (const input of inputs) input.checked = checked; this.sync();};
        this.search.oninput = () => this.filter(); this.list.onchange = () => this.sync();
        this.remove.onclick = () => {void this.deleteSelection();}; actions.append(all, this.remove);
        this.element.append(this.search, actions, this.status, this.list);
    }
    selected(): string[] {return [...this.list.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);}
    setKind(kind: DrawerKind, selected: string[] = []): void {
        if (this.options.signal.aborted) return;
        this.kind = kind; this.status.textContent = ''; this.list.replaceChildren();
        const paths = [...new Set(this.options.paths(kind))].sort((a, b) => this.options.title(a).localeCompare(this.options.title(b), 'zh-CN', {numeric: true}));
        for (const path of paths) {
            const label = document.createElement('label'), input = document.createElement('input');
            input.type = 'checkbox'; input.value = path; input.checked = selected.includes(path);
            label.append(input, document.createTextNode(this.options.title(path))); this.list.append(label);
        }
        this.filter();
    }
    private filter(): void {
        const terms = this.search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        for (const label of this.list.querySelectorAll('label')) label.hidden = !terms.every(term => label.textContent?.toLocaleLowerCase().includes(term));
        this.sync();
    }
    private sync(): void {
        const selected = this.selected();
        this.remove.textContent = t('toolbox.deleteSelected', {count: selected.length});
        this.remove.hidden = !this.options.remove || this.kind === 'tools';
        this.remove.disabled = this.busy || !selected.length || this.options.canRemove?.(selected) === false;
    }
    private lock(): () => void {
        const form = this.element.closest('form');
        const controls = [...(form ?? this.element).querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')]
            .filter(control => !control.closest('.project-dialog__actions') || (control as HTMLButtonElement).type !== 'button');
        const disabled = controls.map(control => control.disabled); controls.forEach(control => {control.disabled = true;});
        return () => controls.forEach((control, index) => {control.disabled = disabled[index];});
    }
    private async deleteSelection(): Promise<void> {
        const paths = this.selected(), {signal, remove, canRemove} = this.options;
        if (this.busy || signal.aborted || !remove || !paths.length || this.kind === 'tools' || canRemove?.(paths) === false) return;
        this.busy = true; const unlock = this.lock(), operationId = randomUUID(), started = Date.now(); this.status.textContent = '';
        // Host confirmation overlays mount outside this dialog, so release the native top layer while awaiting them.
        const dialog = this.element.closest('dialog'), reopen = !!dialog?.open;
        try {
            if (reopen) dialog!.close();
            const result = await remove([...paths], signal);
            if (!signal.aborted && result === 'completed') this.setKind(this.kind, this.selected());
            log.info('organize.delete', {operationId, stage: 'delete', result, count: paths.length, durationMs: Date.now() - started});
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            if (!signal.aborted) {this.setKind(this.kind, this.selected()); this.status.textContent = describeErrorReason(error);}
            log.warn('organize.delete', {operationId, stage: 'delete', result: 'failure', count: paths.length,
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'ORGANIZE_DELETE_FAILED', durationMs: Date.now() - started});
        } finally {
            this.busy = false;
            if (!signal.aborted) {
                if (reopen && dialog?.isConnected && !dialog.open) dialog.showModal();
                unlock(); this.sync();
            }
        }
    }
}

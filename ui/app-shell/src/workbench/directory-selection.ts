import { FILE_ICONS, FILE_BROWSER_ICONS, VFS_TOOLBAR_ICONS, t } from '@itookit/common';
import { decorateButton } from './controls';

export interface DirectoryBulkAction {
    id: 'delete' | 'move' | 'export' | 'copy'; label: string; allows(ids: string[]): boolean; run(ids: string[]): Promise<void>;
}
export class DirectorySelection {
    readonly ids = new Set<string>();
    readonly all = document.createElement('input');
    readonly bar = document.createElement('div');
    private readonly count = document.createElement('span');
    private readonly buttons: HTMLButtonElement[] = [];
    private visible: string[] = [];
    private busy = false;
    constructor(private readonly changed: (ids: string[]) => void, private readonly render: () => void,
        private readonly actions: DirectoryBulkAction[], private readonly refresh: () => Promise<void>, private readonly fail: (error: unknown) => void) {
        this.all.type = 'checkbox'; this.all.setAttribute('aria-label', t('workbench.selectAll'));
        this.all.onchange = () => { for (const id of this.visible) this.all.checked ? this.ids.add(id) : this.ids.delete(id); this.commit(); };
        this.bar.className = 'workbench-directory__selection'; this.bar.append(this.count);
        for (const action of actions) {
            const button = document.createElement('button'); button.type = 'button'; button.dataset.action = `bulk-${action.id}`;
            const icon = action.id === 'copy' ? FILE_ICONS.document : action.id === 'export' ? VFS_TOOLBAR_ICONS.export : FILE_BROWSER_ICONS[action.id];
            decorateButton(button, icon, action.label); button.onclick = () => { void this.run(action); };
            this.buttons.push(button); this.bar.append(button);
        }
        const clear = document.createElement('button'); clear.type = 'button'; decorateButton(clear, FILE_BROWSER_ICONS.close, t('workbench.clearSelection'));
        clear.onclick = () => { this.ids.clear(); this.commit(); }; this.bar.append(clear); this.update();
    }
    checkbox(id: string, name: string): HTMLInputElement {
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.ids.has(id);
        checkbox.setAttribute('aria-label', `${t('workbench.select')} ${name}`); checkbox.dataset.selectionId = id;
        checkbox.onchange = () => { checkbox.checked ? this.ids.add(id) : this.ids.delete(id); this.commit(); }; return checkbox;
    }
    restore(ids: readonly string[], available: string[]): void {
        const known = new Set(available); this.ids.clear();
        for (const id of ids) if (known.has(id)) this.ids.add(id);
    }
    show(ids: string[], available: string[]): void {
        const size = this.ids.size, known = new Set(available); for (const id of this.ids) if (!known.has(id)) this.ids.delete(id);
        if (size !== this.ids.size) this.changed([...this.ids]);
        this.visible = ids; this.update();
    }
    private commit(): void { this.changed([...this.ids]); this.render(); }
    private update(): void {
        const count = this.visible.filter(id => this.ids.has(id)).length;
        this.all.checked = count > 0 && count === this.visible.length; this.all.indeterminate = count > 0 && count < this.visible.length;
        this.all.disabled = this.busy || !this.visible.length; this.bar.hidden = !this.ids.size;
        this.count.textContent = t('workbench.selectedCount', { count: this.ids.size });
        this.buttons.forEach((button, index) => { button.disabled = this.busy || !this.ids.size || !this.actions[index]!.allows([...this.ids]); });
    }
    private async run(action: DirectoryBulkAction): Promise<void> {
        if (this.busy || !this.ids.size || !action.allows([...this.ids])) return;
        this.busy = true; this.update();
        try { await action.run([...this.ids]); await this.refresh(); }
        catch (error) { this.fail(error); }
        finally { this.busy = false; this.update(); }
    }
}

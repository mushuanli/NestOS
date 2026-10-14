import { t } from '@itookit/common';
import type { MenuItem } from '@itookit/ui-common';
import { createMoveOperation, type VFSNodeUI } from '@itookit/vfs-ui';
import { showNameDialog } from '../files/project-dialog';
import { drawerField } from './drawer-field';
import { DRAWER_KINDS, drawerKind, ungroupedId, type Drawer, type DrawerKind } from '@itookit/app-contracts';
import type { ToolboxDrawers } from '@itookit/app-contracts/services';
import { toolboxKind } from './routes';

interface Options {
    groups: ToolboxDrawers; signal: AbortSignal; refresh(): void;
    create(group: Drawer): Promise<unknown>; title(path: string): string;
}
export class DrawerActions {
    constructor(private readonly options: Options) {}
    menu(item: VFSNodeUI): MenuItem<VFSNodeUI>[] {
        const group = this.options.groups.get(item.id), kind = toolboxKind(item.id);
        const action = (id: 'moveDrawer' | 'organize' | 'new' | 'renameDrawer' | 'deleteDrawer', run: () => Promise<unknown>): MenuItem<VFSNodeUI> => ({ id, label: t(`toolbox.${id}`),
            onClick: async () => { await run(); } });
        if (!group) return drawerKind(kind) ? [action('moveDrawer', () => this.move(kind, [item.id]))] : [];
        const items = [group.kind === 'tools' ? action('organize', () => this.move(group.kind, group.paths))
            : action('new', () => this.options.create(group))];
        if (group.id !== ungroupedId(group.kind)) items.push(
            action('renameDrawer', () => showNameDialog(t('toolbox.renameDrawer'), t('toolbox.drawer'), this.options.signal,
                async name => { await this.options.groups.rename(group, name); this.options.refresh(); }, undefined,
                { initialName: group.name, confirmLabel: t('toolbox.save') })),
            action('deleteDrawer', async () => {
                if (!await Promise.resolve(confirm(t('toolbox.deleteDrawerHint', { name: group.name })))) return;
                await this.options.groups.remove(group); this.options.refresh();
            }));
        return items;
    }
    async move(kind: DrawerKind, selected: string[] = []): Promise<void> {
        const { groups, signal } = this.options, picker = drawerField(groups);
        picker.update(kind, selected.length === 1 ? groups.forPath(selected[0])?.name : '');
        const extra = document.createElement('div'); extra.append(picker.field);
        const search = document.createElement('input'); search.type = 'search'; search.placeholder = t('toolbox.searchItems'); search.setAttribute('aria-label', t('toolbox.searchItems'));
        const list = document.createElement('div'); list.className = 'toolbox-organize-list'; extra.append(search, list);
        search.oninput = () => { for (const label of list.querySelectorAll('label')) label.hidden = !label.textContent?.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()); };
        const category = document.createElement('label'); category.textContent = t('toolbox.type');
        const select = document.createElement('select'); select.name = 'kind'; category.append(select); extra.prepend(category);
        for (const value of DRAWER_KINDS) {
            const option = document.createElement('option'); option.value = value; option.textContent = t(`toolbox.${value}`); select.append(option);
        }
        select.value = kind; this.fillItems(list, kind, selected);
        select.onchange = () => { search.value = ''; kind = select.value as DrawerKind; picker.update(kind); this.fillItems(list, kind, []); };
        await showNameDialog(t('toolbox.organize'), t('toolbox.drawer'), signal, async () => {
            const chosen = [...list.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);
            if (!chosen.length) throw new Error(t('toolbox.selectMove'));
            await this.moveItems(chosen, picker.input.value);
        }, extra, { hideName: true, confirmLabel: t('toolbox.moveDrawer') });
    }
    private readonly moveItems = async (paths: string[], name: string): Promise<void> => {
        const move = createMoveOperation<string[], string>({
            resolve: (ids, destination) => ({ batches: [{ ids, execute: async selected => {
                await this.options.groups.assign(selected.map(path => ({ path, name: destination })));
                return 'completed';
            } }] }),
            completed: () => this.options.refresh(),
        });
        await move({ selection: paths, destination: name }, this.options.signal);
    };
    private fillItems(list: HTMLElement, kind: DrawerKind, selected: string[]): void {
        list.replaceChildren();
        const all = document.createElement('button'); all.type = 'button'; all.textContent = t('toolbox.selectAll');
        all.onclick = () => { const inputs = [...list.querySelectorAll<HTMLInputElement>('label:not([hidden]) input')];
            const checked = !inputs.every(input => input.checked); for (const input of inputs) input.checked = checked; };
        list.append(all);
        const paths = [...new Set(this.options.groups.list(kind).flatMap(group => group.paths))];
        paths.sort((a, b) => this.options.title(a).localeCompare(this.options.title(b), 'zh-CN', { numeric: true }));
        for (const path of paths) {
            const label = document.createElement('label'), input = document.createElement('input');
            input.type = 'checkbox'; input.value = path; input.checked = selected.includes(path);
            label.append(input, document.createTextNode(this.options.title(path))); list.append(label);
        }
    }

}

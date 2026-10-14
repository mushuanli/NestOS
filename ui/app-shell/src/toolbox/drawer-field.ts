import { randomUUID, t } from '@itookit/common';
import type { DrawerKind } from '@itookit/app-contracts';
import type { ToolboxDrawers } from '@itookit/app-contracts/services';

/** The native combobox supports typing a name and picking existing groups. */
export function drawerField(drawers: ToolboxDrawers) {
    const field = document.createElement('label'); field.textContent = t('toolbox.drawer');
    const input = document.createElement('input'); input.name = 'drawer'; input.maxLength = 80;
    input.placeholder = t('toolbox.ungrouped'); input.autocomplete = 'off';
    const list = document.createElement('datalist'); list.id = 'drawer-' + randomUUID(); input.setAttribute('list', list.id);
    const hint = document.createElement('small'); hint.setAttribute('aria-live', 'polite');
    field.append(input, list, hint);
    const describe = () => { hint.textContent = input.value.trim() && ![...list.options].some(option => option.value === input.value.trim())
        ? t('toolbox.drawerCreateHint', { name: input.value.trim() }) : t('toolbox.drawerPickHint'); };
    input.oninput = describe;
    const update = (kind: DrawerKind, selected = '') => {
        list.replaceChildren();
        for (const group of drawers.list(kind)) { const option = document.createElement('option'); option.value = group.name; list.append(option); }
        input.value = selected; describe();
    };
    return { field, input, update };
}

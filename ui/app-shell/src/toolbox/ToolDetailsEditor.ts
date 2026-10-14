import type { EditorOptions } from '@itookit/ui-common';
import type { ToolboxResources } from '@itookit/app-contracts/services';
import { toolConfiguration } from './tool-configuration';
import { BaseSettingsEditor, editorResourceId } from '@itookit/ui-common';
import { t } from '@itookit/common';
import type { ToolboxInventory } from '@itookit/app-contracts/services';

export class ToolDetailsEditor extends BaseSettingsEditor<ToolboxInventory> {
    constructor(container: HTMLElement, inventory: ToolboxInventory, options: EditorOptions, private readonly resources?: ToolboxResources) { super(container, inventory, options); }
    async render(): Promise<void> {
        const item = this.service.tools.get(editorResourceId(this.options) ?? '');
        const panel = document.createElement('section'); panel.className = 'toolbox-detail';
        const title = document.createElement('h1'); title.textContent = item?.name ?? t('toolbox.tools');
        const description = document.createElement('p'); description.textContent = item?.description ?? '';
        const source = document.createElement('p'); source.textContent = `${t('toolbox.source')}：${item?.source ?? ''}`;
        const status = document.createElement('p'); status.textContent = t(item?.enabled ? 'toolbox.available' : 'toolbox.unavailable');
        const hint = document.createElement('p'); hint.textContent = t('toolbox.toolsHint');
        panel.append(title, source, status, description, hint);
        if (item?.serverId) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = t('toolbox.manageSource');
            button.onclick = () => { void this.options.hostContext?.navigate({ target: 'toolbox', resourceId: '/mcp/' + encodeURIComponent(item.serverId!) }); };
            panel.append(button);
        }
        if (item?.parameters) {
            const details = document.createElement('details'), summary = document.createElement('summary'), code = document.createElement('pre');
            summary.textContent = t('toolbox.parameters'); code.textContent = JSON.stringify(item.parameters, null, 2);
            details.append(summary, code); panel.append(details);
        }
        if (item && this.resources) panel.append(await toolConfiguration(this.resources, item));
        this.container.replaceChildren(panel);
    }
}

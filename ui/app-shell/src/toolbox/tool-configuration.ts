import { t } from '@itookit/common';
import type { ToolboxResources } from '@itookit/app-contracts/services';
import type { ToolboxTool } from '@itookit/app-contracts/services';

export async function toolConfiguration(resources: ToolboxResources, tool: ToolboxTool): Promise<HTMLElement> {
    const section = document.createElement('section'); section.className = 'toolbox-configuration';
    const title = document.createElement('h2'); title.textContent = t('toolbox.useConfiguration');
    const label = document.createElement('label'); label.textContent = t('toolbox.configureAgent');
    const select = document.createElement('select'); label.append(select);
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = t('toolbox.selectAgent'); select.append(placeholder);
    const agents = await resources.getAgents();
    for (const agent of agents) { const option = document.createElement('option'); option.value = agent.id; option.textContent = agent.name; select.append(option); }
    const allow = document.createElement('input'); allow.type = 'checkbox'; allow.disabled = true;
    const choice = document.createElement('label'); choice.append(allow, t(tool.serverId ? 'toolbox.allowMCP' : 'toolbox.allowTool'));
    const hint = document.createElement('p'); hint.textContent = t('toolbox.grantScope');
    const save = document.createElement('button'); save.type = 'button'; save.textContent = t('action.save'); save.disabled = true;
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    select.onchange = () => {
        const agent = agents.find(item => item.id === select.value); allow.disabled = save.disabled = !agent;
        const current = agent && resources.toolGrant(tool, agent); allow.checked = !!current?.ids.includes(current.id); status.textContent = '';
    };
    save.onclick = () => {
        save.disabled = select.disabled = allow.disabled = true;
        void resources.setToolGrant(tool, select.value, allow.checked).then(async () => {
            agents.splice(0, agents.length, ...await resources.getAgents()); status.textContent = t('toolbox.configurationSaved');
        }).catch(error => { status.textContent = String(error); }).finally(() => { save.disabled = select.disabled = allow.disabled = false; });
    };
    section.append(title, label, choice, hint, save, status); return section;
}

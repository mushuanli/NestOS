import { escapeHTML, t, generateShortUUID } from '@itookit/common';
import type { MCPDiscovery, MCPServer } from '@itookit/tools/mcp-contracts';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { Modal, Toast } from '@itookit/ui-common';

export function renderMCPPrompts(server: MCPServer): string {
    return `<div class="settings-section"><h3 class="settings-section__title">Prompts</h3>${((server.prompts ?? []) as MCPDiscovery['prompts']).map((prompt, index) => `
        <div class="settings-card"><strong>${escapeHTML(prompt.name)}</strong><p>${escapeHTML(prompt.description)}</p>
        <button class="settings-btn" data-action="preview-prompt" data-index="${index}">${t('mcp.preview')}</button></div>`).join('')}</div>`;
}

export function bindMCPContent(container: HTMLElement, server: MCPServer, service: IAgentManagementService): void {
    container.querySelectorAll<HTMLButtonElement>('[data-action="preview-resource"], [data-action="preview-prompt"]').forEach(button => {
        button.addEventListener('click', async () => {
            const index = Number(button.dataset.index);
            if (button.dataset.action === 'preview-prompt') {
                const prompt = (server.prompts as MCPDiscovery['prompts'])?.[index];
                if (prompt) previewPrompt(server.id, prompt, service);
                return;
            }
            const resource = (server.resources as MCPDiscovery['resources'])?.[index];
            if (!resource) return;
            button.disabled = true;
            try { showResult(await service.readMCPResource(server.id, resource.uri)); }
            catch (error) { Toast.error((error as Error).message); }
            finally { button.disabled = false; }
        });
    });
}

function previewPrompt(server: string, prompt: MCPDiscovery['prompts'][number], service: IAgentManagementService): void {
    const id = `mcp-prompt-${generateShortUUID()}`;
    const fields = prompt.arguments ?? [];
    const body = `<div id="${id}">${fields.map((arg, index) => `<label>${escapeHTML(arg.name)}${arg.required ? ' *' : ''}
        <input class="settings-input" data-argument="${index}" placeholder="${escapeHTML(arg.description)}"></label>`).join('')}</div>`;
    new Modal(escapeHTML(prompt.name), body, { onConfirm: async () => {
        const args: Record<string, string> = Object.create(null);
        for (const [index, arg] of fields.entries()) {
            const value = document.querySelector<HTMLInputElement>(`#${id} [data-argument="${index}"]`)!.value;
            if (arg.required && !value) { Toast.error(t('mcp.argumentRequired', { name: arg.name })); return false; }
            if (value) args[arg.name] = value;
        }
        try { showResult(await service.getMCPPrompt(server, prompt.name, args)); }
        catch (error) { Toast.error((error as Error).message); return false; }
    } }).show();
}

function showResult(result: unknown): void {
    const text = JSON.stringify(result, null, 2);
    new Modal(t('mcp.preview'), `<pre style="white-space:pre-wrap;max-height:60vh;overflow:auto">${escapeHTML(text.slice(0, 100000))}${text.length > 100000 ? '\n[truncated]' : ''}</pre>`, { width: '800px' }).show();
}

export function parseMCPStringMap(value: string): Record<string, string> | undefined {
    if (!value.trim()) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error(t('mcp.invalidMap'));
    return parsed as Record<string, string>;
}

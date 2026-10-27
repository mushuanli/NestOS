import { SystemPromptSettingsEditor } from '../../llm-settings-ui/src/editors/SystemPromptSettingsEditor';
// @vitest-environment jsdom
import * as archiveTransfer from '../src/files/archive-transfer';
import { ProviderSettingsEditor } from '../../llm-settings-ui/src/editors/ProviderSettingsEditor';
import { ConnectionSettingsEditor } from '../../llm-settings-ui/src/editors/ConnectionSettingsEditor';
import { toolboxSettingsRoute } from '../src/toolbox/routes';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createToolboxFiles } from '../../../backend/app-core/src/configuration/toolbox-files';
import { createApplicationRuntime, type ApplicationRuntime } from '@itookit/app-core';
import { SkillsEngine } from '../../../backend/app-core/src/configuration/skills-files';
import { BaseSettingsEditor, editorResourceId, type EditorOptions } from '@itookit/ui-common';
import { MCPSettingsEditor } from '../../llm-settings-ui/src/editors/MCPSettingsEditor';
import { FlowCommand } from '@itookit/llm-session';
import { ToolboxInventory } from '@itookit/app-core';
import { ToolboxResources } from '@itookit/app-core';
import { createNestosFlowDrawers } from '../../../backend/app-core/src/presets/flow-library';
import { createNestosProviderTemplates } from '@itookit/kernel-adapters/llm/presets';
import { createFlowContextMenuConfig } from '../../llm-ui-adapter/src/flows/context-menu';
import { ToolboxWorkbench } from '../src/toolbox/ToolboxWorkbench';
import { ToolDetailsEditor } from '../src/toolbox/ToolDetailsEditor';
import { legacyToolboxRoute, TOOLBOX_KINDS } from '../src/toolbox/routes';
import { MCPServerConnection } from '../../../backend/kernel-adapters/src/llm-management/skills/mcp-client';
import { t } from '@itookit/common';
import mediaProbeExamples from '../src/config/media-probe-examples.json';

let runtime: ApplicationRuntime;
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); await runtime?.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
class Editor extends BaseSettingsEditor<object> { async render() { this.container.textContent = editorResourceId(this.options) ?? ''; } }
async function setup(ocr?: import('../src/configuration/ocr-controls').OcrConfigurationControls,
    uiPreferences?: import('../src/toolbox/ToolboxWorkbench').ToolboxPreferencesPort, executorUsage?: EditorOptions['executorUsage'], agentsInWorkbench = false) {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function () { this.removeAttribute('open'); };
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web' });
    await runtime.agentService.saveAgent({ id: 'english', name: 'English teacher', type: 'agent', description: 'language', config: { connectionId: 'default', modelName: '' } });
    await runtime.agentService.saveSkill({ id: 'phrases', name: 'English phrases', type: 'prompt', description: 'extract phrases', enabled: false,
        instructions: 'Extract', tools: [], triggerPatterns: [], autoLoad: false, priority: 50 });
    await runtime.commandBus.execute(FlowCommand.DraftCreate, { id: 'review', name: 'English review' });
    await runtime.agentService.saveMCPServer({ id: 'docs', name: 'Documentation', transport: 'http', autoConnect: false, endpoint: 'https://example.invalid/mcp', tools: [{ name: 'lookup', description: 'Find docs', inputSchema: { type: 'object' } }] });
    const skills = new SkillsEngine(runtime.agentService); cleanup.push(() => skills.dispose());
    const inventory = new ToolboxInventory(() => runtime.agentService.getMCPServers(), runtime.kernel.toolCatalog, runtime.agentService, () => runtime.agentService.listSystemPrompts()); await inventory.init(); cleanup.push(() => inventory.dispose());
    const resources = new ToolboxResources({ agents: await runtime.vfs.openFileSystem('/home/admin/agents'), skills,
        flows: runtime.flowEngine.engine, ...inventory.sources }, runtime.agentService, runtime.commandBus, await runtime.vfs.openFileSystem('/etc'), inventory, createNestosFlowDrawers(), createNestosProviderTemplates());
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async (container: HTMLElement, options: EditorOptions) => { const editor = new Editor(container, {}, options); await editor.init(container); return editor; });
    const factories = { prompts: async (container: HTMLElement, options: EditorOptions) => { const editor = new SystemPromptSettingsEditor(container, runtime.agentService, options); await editor.init(container); return editor; }, agents: factory, skills: factory, flows: factory,
        providers: async (container: HTMLElement, options: EditorOptions) => { const editor = new ProviderSettingsEditor(container, runtime.agentService, options, mediaProbeExamples); await editor.init(container); return editor; },
        connections: async (container: HTMLElement, options: EditorOptions) => { const editor = new ConnectionSettingsEditor(container, runtime.agentService, options); await editor.init(container); return editor; },
        mcp: async (container: HTMLElement, options: EditorOptions) => { const editor = new MCPSettingsEditor(container, runtime.agentService, options); await editor.init(container); return editor; },
        tools: async (container: HTMLElement, options: EditorOptions) => { const editor = new ToolDetailsEditor(container, inventory, options, resources); await editor.init(container); return editor; } };
    const files = createToolboxFiles(resources.sources);
    cleanup.push(() => files.dispose());
    const flowMenu = createFlowContextMenuConfig({ commands: runtime.commandBus, navigate: vi.fn() });
    const navigate = vi.fn();
    const workbench = new ToolboxWorkbench({ ocr, sidebar, editor: main, resources, inventory, files, configuration: runtime.configuration, factories, flowMenu, navigate, selected: vi.fn(), uiPreferences, executorUsage, agentsInWorkbench });
    cleanup.push(() => workbench.destroy()); await workbench.start();
    return { workbench, sidebar, main, factory, resources, inventory, navigate };
}
it('shows explicitly grouped external Flows with the generic Flow context menu', async () => {
    const f = await setup(); f.workbench.setFilter('flows');
    await f.workbench.setVisible(false);
    await runtime.commandBus.execute(FlowCommand.DraftCreate, { id: 'shared-child', name: 'Shared child' });
    await f.resources.drawers.assign([{ path: '/flows/shared-child.flow', name: 'Reusable flows' }]);
    await f.workbench.setVisible(true);
    const drawer = f.resources.drawers.forPath('/flows/shared-child.flow')!;
    const group = () => f.sidebar.querySelector<HTMLElement>(`[data-item-id="${drawer.id}"]`)!;
    expect(group().textContent).toContain('Reusable flows');
    group().querySelector<HTMLElement>('.vfs-directory-item__header')!.click();
    await vi.waitFor(() => expect(group().querySelector('[data-item-id="/flows/shared-child.flow"]')).not.toBeNull());
    expect(group().querySelector('[data-item-id="/flows/review.flow"]')).toBeNull();
    group().querySelector<HTMLButtonElement>('[data-item-id="/flows/shared-child.flow"] [data-action="item-menu"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.vfs-context-menu button[data-action]')?.getAttribute('data-action')).toBe('flow:run'));
});

it('moves the agent entry out of the toolbox while retaining direct configuration links', async () => {
    const f = await setup(undefined, {load: () => ({filter: 'agents'}), save: vi.fn()}, undefined, true);
    expect(f.sidebar.querySelector('[data-filter="agents"]')).toBeNull();
    expect(f.sidebar.querySelector('[data-item-id="/drawers/ungrouped-agents"]')).toBeNull();
    const path = '/agents' + runtime.agentService.getAgentResourceId('english');
    await f.workbench.openResource(path);
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalled()); expect(f.main.textContent).toContain('english.agent');
    f.workbench.setFilter('all');
    expect(f.sidebar.querySelector('[data-item-id="/drawers/ungrouped-agents"]')).toBeNull();
});
it('restores and persists toolbox preferences through the host port', async () => {
    const saved: Array<{ filter: string; queries: Record<string, string> }> = [];
    const f = await setup(undefined, { load: () => ({ filter: 'mcp', queries: { mcp: 'docs', bogus: 'ignored' } }), save: value => saved.push(value as never) });
    const query = f.sidebar.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(query.value).toBe('docs');
    f.workbench.setFilter('agents');
    expect(saved.at(-1)).toMatchObject({ filter: 'agents' });
    // Unknown filter kinds and non-string queries from a hand-edited document are dropped.
    expect(Object.keys(saved.at(-1)!.queries)).toEqual(['mcp']);
});
it('keeps preloaded navigation idle while hidden and merges configuration changes before returning', async () => {
    const f = await setup();
    f.sidebar.querySelector<HTMLElement>('[data-item-id="/drawers/ungrouped-skills"] .vfs-directory-item__header')!.click();
    expect(f.sidebar.textContent).toContain('English phrases');
    await f.workbench.setVisible(false);
    const refresh = vi.spyOn(f.inventory, 'refresh');
    const skill = (await runtime.agentService.getSkills()).find(item => item.id === 'phrases')!;
    await runtime.agentService.saveSkill({ ...skill, name: 'First hidden update' });
    await runtime.agentService.saveSkill({ ...skill, name: 'Latest hidden update' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(refresh).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled();
    await f.workbench.setVisible(true);
    expect(refresh).toHaveBeenCalledOnce(); expect(f.sidebar.textContent).toContain('Latest hidden update');
    refresh.mockClear(); await f.workbench.setVisible(false); await f.workbench.setVisible(true);
    expect(refresh).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled();
});
it('revalidates the toolbox after hiding interrupts an in-flight refresh', async () => {
    const f = await setup();
    f.sidebar.querySelector<HTMLElement>('[data-item-id="/drawers/ungrouped-skills"] .vfs-directory-item__header')!.click();
    const original = f.inventory.refresh.bind(f.inventory);
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const refresh = vi.spyOn(f.inventory, 'refresh').mockImplementationOnce(async () => { await blocked; await original(); });
    cleanup.push(() => finish());
    const skill = (await runtime.agentService.getSkills()).find(item => item.id === 'phrases')!;
    await runtime.agentService.saveSkill({ ...skill, name: 'Interrupted update' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await f.workbench.setVisible(false); finish();
    await f.workbench.setVisible(true);
    expect(refresh).toHaveBeenCalledTimes(2); expect(f.sidebar.textContent).toContain('Interrupted update');
});

it('unifies resource kinds, filters in place and passes original source identities to editors', async () => {
    const f = await setup();
    expect(f.sidebar.querySelectorAll('.vfs-node-list')).toHaveLength(1);
    expect(f.sidebar.querySelector('.vfs-columns')).toBeNull();
    for (const header of f.sidebar.querySelectorAll<HTMLElement>('[data-item-id^="/drawers/ungrouped-"] .vfs-directory-item__header')) header.click();
    for (const name of ['English teacher', 'English phrases', 'English review', 'Documentation']) expect(f.sidebar.textContent).toContain(name);
    expect(f.sidebar.querySelector('[data-item-id="/agents"]')).toBeNull();
    f.workbench.setFilter('skills');
    expect(f.sidebar.textContent).toContain('English phrases'); expect(f.sidebar.textContent).not.toContain('English teacher');
    await f.workbench.openResource('/skills/phrases');
    await vi.waitFor(() => expect(f.factory).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ target: { kind: 'entity', entityType: 'skill', id: 'phrases' } })));
    await f.workbench.openResource('/agents/default/english.agent');
    await vi.waitFor(() => expect(f.factory).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ target: { kind: 'file', path: '/default/english.agent' } })));
    f.workbench.setFilter('all');
    await runtime.agentService.saveSkill({ ...(await runtime.agentService.getSkills()).find(item => item.id === 'phrases')!, name: 'Updated phrases' });
    await vi.waitFor(() => expect(f.sidebar.textContent).toContain('Updated phrases'));
    expect(f.sidebar.textContent).toContain('English review');
    const query = f.sidebar.querySelector<HTMLInputElement>('input[type="search"]')!;
    query.value = 'English'; query.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.sidebar.textContent).not.toContain('Documentation'));
    f.workbench.setFilter('mcp'); expect(query.value).toBe(''); f.workbench.setFilter('all'); expect(query.value).toBe('English');
});
it('opens one MCP form and exposes tool provenance without execution or creation actions', async () => {
    const f = await setup();
    await f.workbench.openResource('/mcp/docs');
    await vi.waitFor(() => expect(f.main.querySelector('[name="endpoint"]')).not.toBeNull());
    expect(f.main.querySelector('.settings-split__sidebar')).toBeNull();
    expect(f.main.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe('Documentation');
    f.workbench.setFilter('tools');
    expect(f.sidebar.querySelector('[data-action="create-file"]')).toBeNull();
    expect(f.sidebar.querySelector('[data-action="import"]')).not.toBeNull();
    const tool = [...f.inventory.tools.values()].find(item => item.serverId === 'docs')!;
    expect(tool).toBeDefined();
    await f.workbench.openResource('/tools/' + encodeURIComponent(tool.id));
    await vi.waitFor(() => expect(f.main.textContent).toContain('管理来源连接'));
    expect(f.main.textContent).toContain('Documentation');
    expect(f.main.querySelector('.workbench-tabs__panel:not([hidden]) button')?.textContent).toBe('管理来源连接');
});
it('preserves original paths in every legacy resource route', () => {
    for (const kind of TOOLBOX_KINDS) expect(legacyToolboxRoute(kind, '/目录/item')).toEqual({ kind, path: '/' + kind + '/目录/item' });
    expect(legacyToolboxRoute('agent-workspace', '/a.agent')?.path).toBe('/agents/a.agent');
});

it('copies editable definitions and resolves tool references without installing or executing them', async () => {
    const f = await setup();
    const paths = ['/agents/default/english.agent', '/skills/phrases', '/flows/review.flow', '/mcp/docs'];
    const tool = [...f.inventory.tools.keys()][0];
    paths.push('/tools/' + encodeURIComponent(tool));
    const imported = await f.resources.import(await f.resources.export(paths));
    await f.inventory.refresh();
    expect(imported).toHaveLength(5);
    for (let i = 0; i < 4; i++) {
        expect(imported[i]).not.toBe(paths[i]);
        const kind = ['agents', 'skills', 'flows', 'mcp'][i] as typeof TOOLBOX_KINDS[number];
        expect(await f.resources.sources[kind].driver.exists(imported[i].slice(kind.length + 1)), `${kind}: ${imported[i]}`).toBe(true);
    }
    expect(imported[4]).toBe(paths[4]);
    expect(await runtime.agentService.getAgents()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'english', name: 'English teacher' })]));
    const mcp = (await runtime.agentService.getMCPServers()).find(item => item.id !== 'docs')!;
    expect(mcp.autoConnect).toBe(false); expect(mcp.tools).toEqual([]);
    const before = (await runtime.agentService.getSkills()).length;
    const malformed = JSON.parse(await f.resources.export(['/skills/phrases']));
    malformed.entries.push({ kind: 'tools', data: { id: 'missing', name: 'Missing source' } });
    await expect(f.resources.import(JSON.stringify(malformed))).rejects.toThrow();
    expect((await runtime.agentService.getSkills()).length).toBe(before);
});
it('creates resources at paths that their owning editors can reopen', async () => {
    const f = await setup();
    for (const kind of TOOLBOX_KINDS.filter(kind => kind !== 'tools')) {
        const path = await f.resources.create(kind, 'Created ' + kind);
        expect(await f.resources.sources[kind].driver.exists(path.slice(kind.length + 1))).toBe(!['prompts', 'mcp', 'providers', 'connections'].includes(kind));
        await f.inventory.refresh();
        expect(await f.resources.sources[kind].driver.exists(path.slice(kind.length + 1))).toBe(true);
    }
});

it('keeps tool name order when selecting, filtering and refreshing', async () => {
    const f = await setup(); f.workbench.setFilter('tools');
    for (const header of f.sidebar.querySelectorAll<HTMLElement>('.vfs-directory-item__header')) header.click();
    const order = () => [...f.sidebar.querySelectorAll<HTMLElement>('[data-item-type="file"]')].map(node => node.dataset.itemId);
    const before = order(); expect(before.length).toBeGreaterThan(3);
    for (const path of before.slice(-3)) { await f.workbench.openResource(path!); expect(order()).toEqual(before); }
    await runtime.agentService.saveMCPServer({ id: 'empty', name: 'New empty connection', transport: 'http' });
    await vi.waitFor(() => expect(f.inventory.sources.mcp.driver.exists('/empty')).resolves.toBe(true));
    expect(order()).toEqual(before);
    f.workbench.setFilter('all'); f.workbench.setFilter('tools'); expect(order()).toEqual(before);
});
it('groups providers by availability and keeps settings before their connections', async () => {
    const f = await setup();
    for (const [id, name, apiKey, enabled] of [
        ['ready', 'Z Ready', 'secret', true], ['empty', 'A Empty', '', true], ['off', 'A Disabled', 'secret', false],
    ] as const) await runtime.agentService.saveProvider({ baseURL: '', id, name, apiKey, enabled, icon: 'R', implementation: 'openai-compatible', models: [{id: 'chat', name: 'Chat model', category: 'chat'}] });
    await runtime.agentService.saveConnection({ id: 'drawer-conn', name: 'A Connection', providerId: 'ready', model: 'chat' });
    await vi.waitFor(() => expect(f.inventory.connections.has('drawer-conn')).toBe(true));
    f.workbench.setFilter('models');
    const groups = () => [...f.sidebar.querySelectorAll<HTMLElement>('[data-item-type="directory"]')].map(node => node.dataset.itemId);
    const before = groups();
    expect(before.indexOf('/model-groups/ready')).toBeLessThan(before.indexOf('/model-groups/empty'));
    expect(before.indexOf('/model-groups/empty')).toBeLessThan(before.indexOf('/model-groups/off'));
    await f.workbench.openResource('/connections/drawer-conn');
    const group = () => f.sidebar.querySelector('[data-item-id="/model-groups/ready"]')!;
    expect([...group().querySelectorAll<HTMLElement>('[data-item-type="file"]')].map(node => node.dataset.itemId).slice(0, 2)).toEqual(['/providers/ready', '/connections/drawer-conn']);
    expect(group().querySelector('.vfs-directory-item__icon')?.textContent).toBe('R');
    expect(group().querySelector('.vfs-directory-item__description')?.textContent).not.toContain(t('toolbox.providerConfigured'));
    expect(group().querySelector('[aria-label="服务商"]')).not.toBeNull();
    expect(group().querySelector(`[data-item-id="/connections/drawer-conn"] .vfs-node-item__semantic-icon[aria-label="${t('toolbox.capability.chat')}"]`)).not.toBeNull();
    expect(group().querySelector('[data-item-id="/connections/drawer-conn"] [aria-label="模型连接"]')).not.toBeNull();
    expect(f.sidebar.textContent).not.toContain('secret');
    expect(groups()).toEqual(before);
    f.sidebar.querySelector<HTMLButtonElement>('[data-action="create-file"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.project-dialog')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-create-kind="connections"]')!.click();
    expect(document.querySelector('.project-dialog h2')?.textContent).toBe(t('toolbox.connectionType'));
    expect(document.querySelector<HTMLSelectElement>('.project-dialog [name="providerId"]')?.value).toBe('ready');
    document.querySelector<HTMLInputElement>('.project-dialog [name="resourceName"]')!.value = 'New connection';
    document.querySelector<HTMLFormElement>('.project-dialog form')!.requestSubmit();
    await vi.waitFor(async () => expect((await runtime.agentService.getConnections()).find(c => c.name === 'New connection')?.providerId).toBe('ready'));
    expect((await runtime.agentService.getConnections()).find(c => c.name === 'New connection')?.enabled).toBe(true);
    await vi.waitFor(() => expect(group().querySelector('.vfs-directory-item__description')?.textContent).toContain('3 个连接'));
});
it('keeps metadata title changes out of drawer relocation commands', async () => {
    const f = await setup(), relocate = vi.spyOn(f.resources.drawers, 'relocate');
    const provider = (await runtime.agentService.getFullProvider('doubao-speech'))!;
    await runtime.agentService.saveProvider({ ...provider, name: 'Renamed provider' });
    await vi.waitFor(() => expect(f.inventory.providers.get('doubao-speech')?.name).toBe('Renamed provider'));
    expect(relocate).not.toHaveBeenCalled();
});

it('pins the default drawer and orders enabled ready connections ahead of incomplete and disabled ones', async () => {
    const f = await setup();
    for (const [id, name, apiKey] of [['usage-ready', 'Z Ready provider', 'secret'], ['usage-default', 'Default provider', '']] as const)
        await runtime.agentService.saveProvider({id, name, apiKey, enabled: true, baseURL: '', implementation: 'openai-compatible', models: [{id: 'chat', name: 'Chat model', category: 'chat'}, {id: 'image', name: 'Image model', category: 'image'}]});
    for (const connection of [
        {id: 'usage-ready-chat', name: 'Z Ready chat', providerId: 'usage-ready', model: 'chat'},
        {id: 'usage-incomplete', name: 'B Missing chat model', providerId: 'usage-ready', model: 'image', tiers: {optimal: 'image'}},
        {id: 'usage-disabled', name: 'A Disabled chat', providerId: 'usage-ready', model: 'chat', enabled: false},
        {id: 'usage-default-chat', name: 'Default chat', providerId: 'usage-default', model: 'chat'},
    ]) await runtime.agentService.saveConnection(connection);
    await runtime.agentService.setDefaultConnection('usage-default-chat');
    await vi.waitFor(() => expect(f.inventory.defaultConnectionId).toBe('usage-default-chat'));
    expect(f.inventory.connections.get('usage-incomplete')).toMatchObject({model: null});
    f.workbench.setFilter('models');
    const groups = [...f.sidebar.querySelectorAll<HTMLElement>('[data-item-type="directory"]')];
    expect(groups[0].dataset.itemId).toBe('/model-groups/usage-default');
    expect(groups[0].textContent).toContain(t('modelDefaults.default'));
    expect(groups[0].textContent).toContain(t('connection.credentialsRequired'));
    await f.workbench.openResource('/connections/usage-ready-chat');
    const group = f.sidebar.querySelector('[data-item-id="/model-groups/usage-ready"]')!;
    const order = [...group.querySelectorAll<HTMLElement>('[data-item-type="file"]')].map(row => row.dataset.itemId);
    expect(order[0]).toBe('/providers/usage-ready');
    expect(order.indexOf('/connections/usage-ready-chat')).toBeLessThan(order.indexOf('/connections/usage-incomplete'));
    expect(order.indexOf('/connections/usage-incomplete')).toBeLessThan(order.indexOf('/connections/usage-disabled'));
    const disabled = group.querySelector('[data-item-id="/connections/usage-disabled"]')!;
    expect(disabled.classList.contains('vfs-node-item--muted')).toBe(true);
    expect(disabled.querySelector('.vfs-node-item__title')?.textContent).toBe('A Disabled chat');
    expect(disabled.querySelector('.vfs-node-item__conn-label')?.textContent).toContain('Chat model');
    expect(disabled.querySelector('.vfs-node-item__summary')).toBeNull();
    disabled.querySelector<HTMLElement>('[data-action="select-and-open"]')!.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/connections/usage-disabled'));
    const provider = await runtime.agentService.getFullProvider('usage-ready');
    await runtime.agentService.saveProvider({...provider!, enabled: false});
    await vi.waitFor(() => expect(f.inventory.providers.get('usage-ready')?.enabled).toBe(false));
    await vi.waitFor(() => {
        const disabledProvider = f.sidebar.querySelector('[data-item-id="/model-groups/usage-ready"]')!;
        const order = [...disabledProvider.querySelectorAll<HTMLElement>('[data-item-type="file"]')].map(row => row.dataset.itemId!);
        let reachedDisabled = false;
        for (const path of order.filter(path => path.startsWith('/connections/'))) {
            const connection = f.inventory.connections.get(decodeURIComponent(path.slice('/connections/'.length)))!;
            if (!connection.enabled) reachedDisabled = true; else expect(reachedDisabled).toBe(false);
        }
        expect(reachedDisabled).toBe(true);
    });
});

it('searches providers, connections and assistants by display name and reveals matching drawers after recency sorting', async () => {
    const times = new Map([['english', 50]]); let changed = () => {};
    const f = await setup(undefined, undefined, {lastUsed: id => times.get(id) ?? 0, record() {}, subscribe: listener => { changed = listener; return () => {}; }});
    await runtime.agentService.saveAgent({id: 'writing', name: '中文写作助手', type: 'agent', config: {}});
    await runtime.agentService.saveProvider({id: 'search-provider', name: '可搜索服务商', enabled: true, apiKey: 'secret', baseURL: '', implementation: 'openai-compatible', models: []});
    await runtime.agentService.saveConnection({id: 'search-connection', name: '可搜索连接', providerId: 'search-provider', model: 'chat'});
    await vi.waitFor(() => expect(f.inventory.connections.has('search-connection')).toBe(true));
    f.workbench.setFilter('models');
    const input = f.sidebar.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = '可搜索服务商'; input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/model-groups/search-provider"]')).not.toBeNull());
    input.value = '可搜索连接'; input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/connections/search-connection"]')?.textContent).toContain('可搜索连接'));
    expect(f.sidebar.querySelector('[data-item-id="/model-groups/search-provider"] .vfs-directory-item__header')?.getAttribute('aria-expanded')).toBe('true');
    f.workbench.setFilter('agents'); input.value = '中文写作助手'; input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/agents/default/writing.agent"]')?.textContent).toContain('中文写作助手'));
    input.value = ''; input.dispatchEvent(new Event('input'));
    await f.workbench.openResource('/agents/default/english.agent');
    const order = () => [...f.sidebar.querySelectorAll<HTMLElement>('[data-item-type="file"]')].map(row => row.dataset.itemId);
    expect(order().indexOf('/agents/default/english.agent')).toBeLessThan(order().indexOf('/agents/default/writing.agent'));
    times.set('writing', 100); changed();
    await vi.waitFor(() => expect(order().indexOf('/agents/default/writing.agent')).toBeLessThan(order().indexOf('/agents/default/english.agent')));
});
it('groups tools by purpose and MCP source, and search reveals nested matches', async () => {
    const f = await setup(); f.workbench.setFilter('tools');
    expect(f.sidebar.querySelector('[data-item-id="/tool-groups/files"]')).not.toBeNull();
    expect(f.sidebar.querySelector('[data-item-id="/tool-groups/mcp-docs"]')).not.toBeNull();
    const query = f.sidebar.querySelector<HTMLInputElement>('input[type="search"]')!;
    query.value = 'lookup'; query.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/tools/mcp%3Adocs%3Alookup"]')).not.toBeNull());
    expect(f.sidebar.querySelector('[data-item-id="/tool-groups/files"]')).toBeNull();
    expect(f.sidebar.querySelector('[data-item-id="/tool-groups/mcp-docs"] .vfs-directory-item__header')?.getAttribute('aria-expanded')).toBe('true');
    await f.workbench.openResource('/tools/builtin%3ARead');
    expect(f.sidebar.querySelector('[data-item-id="/tool-groups/files"] .vfs-directory-item__header')?.getAttribute('aria-expanded')).toBe('true');
});
it('edits model resources inline, keeps provider keys out of the list and remaps archived connections', async () => {
    const f = await setup();
    await runtime.agentService.saveProvider({ id: 'custom', name: 'Local model', implementation: 'openai-compatible', baseURL: 'http://localhost:1234', apiKey: 'private-key', models: [] });
    await runtime.agentService.saveConnection({ id: 'custom-conn', name: 'Fast model', providerId: 'custom', enabled: false, metadata: { custom: 'keep' } });
    await vi.waitFor(() => expect(f.sidebar.textContent).toContain('Local model'));
    expect(f.sidebar.textContent).not.toContain('private-key');
    f.workbench.setFilter('models');
    await f.workbench.openResource('/providers/custom');
    await vi.waitFor(() => expect(f.main.querySelector('#provider-form')).not.toBeNull());
    expect(f.main.querySelector<HTMLInputElement>('[name="apiKey"]')?.value).toBe('');
    expect(f.main.querySelector('#providers-list')).toBeNull();
    await f.workbench.openResource('/connections/custom-conn');
    await vi.waitFor(() => expect(f.main.querySelector('#connection-form')).not.toBeNull());
    expect(f.main.querySelector('.settings-split__sidebar')).toBeNull();
    const name = f.main.querySelector<HTMLInputElement>('[name="name"]')!; name.value = 'Updated model';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    name.dispatchEvent(new Event('focusout', { bubbles: true }));
    await vi.waitFor(async () => expect((await runtime.agentService.getFullConnection('custom-conn'))?.name).toBe('Updated model'));
    expect(await runtime.agentService.getFullConnection('custom-conn')).toMatchObject({ enabled: false, metadata: { custom: 'keep' } });
    const paths = await f.resources.import(await f.resources.export(['/connections/custom-conn', '/providers/custom']));
    const providerId = paths.find(path => path.startsWith('/providers/'))!.split('/').pop()!;
    const connectionId = paths.find(path => path.startsWith('/connections/'))!.split('/').pop()!;
    expect((await runtime.agentService.getFullConnection(connectionId))?.providerId).toBe(providerId);
    expect((await runtime.agentService.getFullProvider(providerId))?.apiKey).toBe('private-key');
});
it('writes tool usage into the selected agent policy and preserves unrelated grants', async () => {
    const f = await setup();
    const agent = (await runtime.agentService.getAgents()).find(item => item.id === 'english')!;
    await runtime.agentService.saveAgent({ ...agent, capabilityPolicy: { toolIds: ['read', 'write'], skillIds: ['phrases'], mcpProfileIds: [] } });
    const tool = { id: 'builtin:read', name: 'Read', description: '', source: 'builtin', enabled: true };
    await f.resources.setToolGrant(tool, 'english', false);
    expect((await runtime.agentService.getAgents()).find(item => item.id === 'english')?.capabilityPolicy).toMatchObject({ toolIds: ['write'], skillIds: ['phrases'], mcpProfileIds: [] });
    await f.resources.setToolGrant({ ...tool, serverId: 'docs' }, 'english', true);
    expect((await runtime.agentService.getAgents()).find(item => item.id === 'english')?.capabilityPolicy).toMatchObject({ toolIds: ['write'], skillIds: ['phrases'], mcpProfileIds: ['docs'] });
});
it('redirects moved settings pages and their selected resource anchors', () => {
    expect(toolboxSettingsRoute('providers', 'custom')).toBe('/providers/custom');
    expect(toolboxSettingsRoute('connections', 'conn:fast')).toBe('/connections/fast');
    expect(toolboxSettingsRoute('/MCP Servers')).toBe('/mcp');
    expect(toolboxSettingsRoute('appearance')).toBeUndefined();
});

it('creates every editable category in named drawers and persists their organization in VFS', async () => {
    const f = await setup();
    for (const kind of ['agents', 'skills', 'flows', 'prompts', 'mcp'] as const) {
        f.workbench.setFilter(kind);
        const pending = f.workbench.createResource();
        const dialog = document.querySelector('.project-dialog')!;
        dialog.querySelector<HTMLButtonElement>(`[data-create-kind="${kind}"]`)!.click();
        dialog.querySelector<HTMLInputElement>('[name="resourceName"]')!.value = 'Grouped ' + kind;
        dialog.querySelector<HTMLInputElement>('[name="drawer"]')!.value = '学习';
        dialog.querySelector('form')!.requestSubmit();
        const path = await pending;
        const group = f.resources.drawers.forPath(path)!;
        expect(group).toMatchObject({ kind, name: '学习', paths: [path] });
        expect(f.sidebar.querySelector(`[data-item-id="${group.id}"] [data-item-id="${path}"]`)).not.toBeNull();
        expect(await f.resources.sources[kind].driver.exists(path.slice(kind.length + 1))).toBe(true);
        const again = f.workbench.createResource();
        document.querySelector<HTMLButtonElement>(`[data-create-kind="${kind}"]`)!.click();
        expect(document.querySelector<HTMLInputElement>('.project-dialog [name="drawer"]')?.value, kind).toBe('学习');
        expect([...document.querySelectorAll<HTMLOptionElement>('.project-dialog datalist option')].map(option => option.value)).toContain('学习');
        document.querySelector('.project-dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); await again;
    }
    const { ToolboxDrawers } = await import('@itookit/app-core');
    const reloaded = new ToolboxDrawers(await runtime.vfs.openFileSystem('/etc')); await reloaded.init();
    expect(reloaded.snapshot().filter(item => item.name === '学习')).toHaveLength(5);
});
it('moves tool references in bulk without changing definitions and deleting a drawer only ungroups them', async () => {
    const f = await setup(); f.workbench.setFilter('all');
    f.sidebar.querySelector<HTMLButtonElement>('.vfs-node-list__secondary-action')!.click();
    expect(document.querySelector<HTMLSelectElement>('.project-dialog [name="kind"]')?.value).toBe('flows');
    expect(document.querySelector('.project-dialog [name="kind"] option[value="agents"]')).toBeNull();
    expect(f.sidebar.querySelector('[data-action="select-items"]')).toBeNull();
    document.querySelector('.project-dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    f.workbench.setFilter('tools');
    const paths = [...f.inventory.tools.keys()].slice(0, 2).map(id => '/tools/' + encodeURIComponent(id));
    const definitions = paths.map(path => f.inventory.tools.get(decodeURIComponent(path.slice('/tools/'.length))));
    f.sidebar.querySelector<HTMLButtonElement>('.vfs-node-list__secondary-action')!.click();
    await vi.waitFor(() => expect(document.querySelector('.toolbox-organize-list')).not.toBeNull());
    document.querySelector<HTMLInputElement>('.project-dialog [name="drawer"]')!.value = '常用';
    for (const input of document.querySelectorAll<HTMLInputElement>('.toolbox-organize-list input')) input.checked = paths.includes(input.value);
    document.querySelector<HTMLFormElement>('.project-dialog form')!.requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.project-dialog')).toBeNull());
    const group = f.resources.drawers.forPath(paths[0])!;
    expect([...group.paths].sort()).toEqual([...paths].sort());
    expect(paths.map(path => f.inventory.tools.get(decodeURIComponent(path.slice('/tools/'.length))))).toEqual(definitions);
    f.sidebar.querySelector<HTMLButtonElement>(`[data-item-id="${group.id}"] [data-action="item-menu"]`)!.click();
    vi.stubGlobal('confirm', () => true);
    document.querySelector<HTMLButtonElement>('[data-action="deleteDrawer"]')!.click();
    await vi.waitFor(() => expect(f.resources.drawers.forPath(paths[0])?.name).toBe('未分组'));
    expect(f.sidebar.querySelector(`[data-item-id="${group.id}"]`)).toBeNull();
    for (const path of paths) expect(await f.resources.sources.tools.driver.exists(path.slice('/tools'.length))).toBe(true);
});

async function organizeSelection(f: Awaited<ReturnType<typeof setup>>, kind: 'flows' | 'skills' | 'prompts' | 'tools', path?: string) {
    f.workbench.setFilter(kind);
    f.sidebar.querySelector<HTMLButtonElement>('.vfs-node-list__secondary-action')!.click();
    await vi.waitFor(() => expect(document.querySelector('.toolbox-organize-list')).not.toBeNull());
    const dialog = document.querySelector<HTMLDialogElement>('.project-dialog')!;
    if (path) {
        const input = [...dialog.querySelectorAll<HTMLInputElement>('.toolbox-organize-list input')].find(input => input.value === path)!;
        expect(input).toBeDefined(); input.checked = true; input.dispatchEvent(new Event('change', {bubbles: true}));
    }
    return {dialog, remove: dialog.querySelector<HTMLButtonElement>('[data-action="delete-organized"]')!};
}

it('deletes selected definitions inside the organizer and preserves the destination draft', async () => {
    const f = await setup(); vi.stubGlobal('confirm', () => true);
    const {dialog, remove} = await organizeSelection(f, 'flows', '/flows/review.flow');
    dialog.querySelector<HTMLInputElement>('[name="drawer"]')!.value = 'Keep destination';
    expect(dialog.querySelector('[name="kind"] option[value="agents"]')).toBeNull();
    expect(f.sidebar.querySelector('[data-action="select-items"]')).toBeNull();
    expect(remove.disabled).toBe(false); remove.click(); remove.click();
    await vi.waitFor(() => expect(dialog.querySelector('.toolbox-organize-list input[value="/flows/review.flow"]')).toBeNull());
    expect(await f.resources.sources.flows.driver.exists('/review.flow')).toBe(false);
    expect(dialog.open).toBe(true); expect(dialog.querySelector<HTMLInputElement>('[name="drawer"]')!.value).toBe('Keep destination');
    expect(remove.disabled).toBe(true);
    dialog.dispatchEvent(new Event('cancel', {cancelable: true}));
});

it('keeps organizer selection and reports the actual deletion error, then allows an explicit retry', async () => {
    const f = await setup(), confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
    const {dialog, remove} = await organizeSelection(f, 'skills', '/skills/phrases');
    remove.click(); await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(dialog.open && !remove.disabled).toBe(true));
    expect(dialog.querySelector<HTMLInputElement>('.toolbox-organize-list input[value="/skills/phrases"]')!.checked).toBe(true);
    confirm.mockReturnValue(true);
    const deletion = vi.spyOn(f.resources.sources.skills.driver, 'delete').mockRejectedValueOnce(new Error('Organizer storage unavailable'));
    remove.click(); await vi.waitFor(() => expect(dialog.querySelector('.toolbox-organize-status')?.textContent).toContain('Organizer storage unavailable'));
    expect(dialog.querySelector<HTMLInputElement>('.toolbox-organize-list input[value="/skills/phrases"]')!.checked).toBe(true);
    expect(dialog.open).toBe(true); expect(deletion).toHaveBeenCalledOnce();
    remove.click(); await vi.waitFor(() => expect(dialog.querySelector('.toolbox-organize-list input[value="/skills/phrases"]')).toBeNull());
    expect(deletion).toHaveBeenCalledTimes(2); dialog.dispatchEvent(new Event('cancel', {cancelable: true}));
});

it('uses the existing prompt dependency confirmation above the organizer and restores it on cancellation', async () => {
    const f = await setup(); vi.stubGlobal('confirm', () => true);
    const {dialog, remove} = await organizeSelection(f, 'prompts', '/prompts/default'); remove.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    expect(dialog.open).toBe(false);
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    await vi.waitFor(() => expect(dialog.open).toBe(true));
    expect(dialog.querySelector<HTMLInputElement>('.toolbox-organize-list input[value="/prompts/default"]')!.checked).toBe(true);
    expect(await runtime.agentService.getSystemPrompt('default')).not.toBeNull();
    remove.click(); await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(dialog.querySelector('.toolbox-organize-list input[value="/prompts/default"]')).toBeNull());
    expect(await runtime.agentService.getSystemPrompt('default')).toBeNull(); expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new Event('cancel', {cancelable: true}));
});

it('keeps discovered tool references available for organization without offering definition deletion', async () => {
    const f = await setup(), {dialog, remove} = await organizeSelection(f, 'tools');
    expect(remove.hidden).toBe(true); expect(dialog.querySelector('[name="kind"] option[value="agents"]')).toBeNull();
    dialog.dispatchEvent(new Event('cancel', {cancelable: true}));
});

it('does not dispatch organizer deletion or reopen its dialog after the workbench closes during confirmation', async () => {
    const f = await setup(); let finish!: (confirmed: boolean) => void;
    vi.stubGlobal('confirm', () => new Promise<boolean>(resolve => {finish = resolve;}));
    const deletion = vi.spyOn(f.resources.sources.skills.driver, 'delete');
    const {dialog, remove} = await organizeSelection(f, 'skills', '/skills/phrases'); remove.click();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await f.workbench.destroy(); finish(true); await new Promise(resolve => setTimeout(resolve, 0));
    expect(deletion).not.toHaveBeenCalled(); expect(dialog.isConnected).toBe(false);
    expect(await runtime.agentService.getSkills()).toHaveLength(1);
});
it('keeps the original toolbar and all resource types available from model creation', async () => {
    const f = await setup(); f.workbench.setFilter('models');
    expect(f.sidebar.querySelector('[data-action="create-file"]')?.textContent).toContain(t('toolbox.new'));
    expect(f.sidebar.querySelector('[data-action="create-connection"]')).toBeNull();
    const pending = f.workbench.createResource();
    const dialog = document.querySelector('.project-dialog')!;
    expect(dialog.querySelector('fieldset')?.hidden).toBe(true);
    expect([...dialog.querySelectorAll<HTMLButtonElement>('[data-create-kind]')].map(button => button.dataset.createKind)).toEqual(TOOLBOX_KINDS.filter(kind => kind !== 'tools'));
    expect(dialog.querySelector('[data-create-kind="providers"]')?.textContent).toBe('模型服务商');
    expect(dialog.querySelector('[data-create-kind="connections"]')?.textContent).toBe('模型连接');
    dialog.querySelector<HTMLButtonElement>('[data-create-kind="providers"]')!.click();
    const providers = dialog.querySelector<HTMLSelectElement>('[name="providerId"]')!;
    expect(providers.closest('label')!.hidden).toBe(true);
    expect(dialog.querySelector('[role="combobox"]')).not.toBeNull();
    expect(dialog.querySelector('button[type="submit"]')?.textContent).toBe(t('toolbox.addAndConfigure'));
    dialog.querySelector<HTMLButtonElement>('.toolbox-create__back')!.click();
    dialog.querySelector<HTMLButtonElement>('[data-create-kind="connections"]')!.click();
    expect(providers.closest('label')!.hidden).toBe(false);
    expect(providers.value).toBe('');
    expect(dialog.querySelector<HTMLInputElement>('[role="combobox"]')?.disabled).toBe(true);
    dialog.dispatchEvent(new Event('cancel', {cancelable: true})); await pending;
});

it('keeps global creation broad after selecting a drawer', async () => {
    const f = await setup(); await f.workbench.openResource('/skills/phrases'); f.workbench.setFilter('all');
    const first = f.workbench.createResource();
    expect(document.querySelector<HTMLFieldSetElement>('.toolbox-create fieldset')?.hidden).toBe(true);
    expect(document.querySelector<HTMLDivElement>('.toolbox-create__choices')?.hidden).toBe(false);
    document.querySelector('.toolbox-create')!.dispatchEvent(new Event('cancel', {cancelable: true})); await first;
});

it('loads the JSON image example for Volcengine without validating automatically', async () => {
    const f = await setup(), verify = vi.spyOn(runtime.agentService, 'testConnection');
    await f.workbench.openResource('/providers/volcengine');
    await vi.waitFor(() => expect(f.main.querySelector('[data-probe-input]')).not.toBeNull());
    const input = f.main.querySelector<HTMLTextAreaElement>('[data-probe-input]')!;
    expect(input.value).toBe(mediaProbeExamples['image.generate'].input);
    expect(input.value).toContain('鹈鹕'); expect(verify).not.toHaveBeenCalled();
});

it('uses preset names and configures new speech providers inside the creation dialog', async () => {
    const f = await setup(); f.workbench.setFilter('models');
    await runtime.agentService.deleteProvider('doubao-speech');
    await vi.waitFor(() => expect(f.inventory.providers.has('doubao-speech')).toBe(false));
    const verify = vi.spyOn(runtime.agentService, 'testConnection');
    const pending = f.workbench.createResource();
    const dialog = document.querySelector('.project-dialog')!;
    dialog.querySelector<HTMLButtonElement>('[data-create-kind="providers"]')!.click();
    const search = dialog.querySelector<HTMLInputElement>('[name="providerTemplateSearch"]')!;
    const choose = (id: string) => { search.click(); dialog.querySelector<HTMLButtonElement>(`[data-template-id="${id}"]`)!.click(); };
    choose('doubao-speech');
    const name = dialog.querySelector<HTMLInputElement>('[name="resourceName"]')!;
    expect(name.closest('label')?.hidden).toBe(true); expect(search.value).toBe('Doubao (豆包语音)');
    choose('deepseek'); expect(search.value).toBe('Doubao (豆包语音)');
    expect(dialog.querySelector<HTMLButtonElement>('[data-template-id="deepseek"]')!.disabled).toBe(true);
    search.value = '豆包'; search.dispatchEvent(new Event('input'));
    expect(search.checkValidity()).toBe(true);
    expect(dialog.querySelector('[data-template-id="openai"]')).toBeNull();
    expect(dialog.querySelector('[data-template-id="custom"]')).not.toBeNull();
    dialog.querySelector<HTMLButtonElement>('[data-template-id="doubao-speech"]')!.click();
    dialog.querySelector('form')!.requestSubmit();
    await vi.waitFor(() => expect(dialog.classList.contains('toolbox-create--setup')).toBe(true));
    await vi.waitFor(() => expect(dialog.querySelector('[data-probe-voice] option')?.textContent).toContain('Vivi 2.0'));
    expect(dialog.querySelector('[data-provider-reference]')).not.toBeNull();
    expect(dialog.querySelector('[name="baseURL"]')).not.toBeNull(); expect(f.main.querySelector('[name="baseURL"]')).toBeNull();
    dialog.querySelector<HTMLButtonElement>('[data-action="complete-setup"]')!.click(); const path = await pending;
    const provider = (await runtime.agentService.getFullProvider(decodeURIComponent(path.slice('/providers/'.length))))!;
    expect(provider).toMatchObject({name: 'Doubao (豆包语音)', isBuiltin: false, media: {'speech.synthesize': {adapter: 'doubao-speech'}}});
    expect(provider.models[0].operations?.['speech.synthesize']?.voices?.length).toBeGreaterThan(0);
    expect(provider.id).toBe('doubao-speech'); expect(provider.apiKey).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
});

it('creates an empty custom provider without requiring a preset or generating requests', async () => {
    const f = await setup(); f.workbench.setFilter('models');
    const pending = f.workbench.createResource(), dialog = document.querySelector('.project-dialog')!;
    dialog.querySelector<HTMLButtonElement>('[data-create-kind="providers"]')!.click();
    dialog.querySelector<HTMLInputElement>('[role="combobox"]')!.click();
    const customName = dialog.querySelector<HTMLInputElement>('[role="combobox"]')!;
    customName.value = 'My gateway'; customName.dispatchEvent(new Event('input'));
    dialog.querySelector('form')!.requestSubmit();
    await vi.waitFor(() => expect(dialog.classList.contains('toolbox-create--setup')).toBe(true));
    dialog.querySelector<HTMLButtonElement>('[data-action="complete-setup"]')!.click(); const path = await pending;
    expect(await runtime.agentService.getFullProvider(path.slice('/providers/'.length))).toMatchObject({name: 'My gateway', baseURL: '', models: [], isBuiltin: false});
});

it('round trips drawer names with resources and keeps cancelled new drawer names out of storage', async () => {
    const f = await setup(); f.workbench.setFilter('skills');
    const pending = f.workbench.createResource();
    document.querySelector<HTMLInputElement>('.project-dialog [name="drawer"]')!.value = 'Cancelled';
    document.querySelector('.project-dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); await pending;
    expect(f.resources.drawers.snapshot().some(item => item.name === 'Cancelled')).toBe(false);
    await f.resources.drawers.assign([{ path: '/skills/phrases', name: '学习' }]); f.workbench.setFilter('skills');
    const archive = await f.resources.export(['/skills/phrases']);
    expect(JSON.parse(archive).entries[0].drawer).toBe('学习');
    const [copy] = await f.resources.import(archive);
    await vi.waitFor(() => expect(f.resources.drawers.forPath(copy)?.name).toBe('学习'));
    expect(copy).not.toBe('/skills/phrases');
    const group = f.resources.drawers.forPath(copy)!;
    await f.resources.drawers.rename(group, '语言'); f.workbench.setFilter('skills');
    await vi.waitFor(() => expect(f.resources.drawers.forPath('/skills/phrases')?.name).toBe('语言'));
    expect(f.resources.drawers.forPath(copy)?.name).toBe('语言');
});
it('rolls back a newly created resource if saving its drawer fails and round trips empty drawers', async () => {
    const f = await setup();
    const before = (await runtime.agentService.getSkills()).map(skill => skill.id);
    vi.spyOn(f.resources.drawers, 'assign').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.resources.createInDrawer('skills', 'Failed draft', 'New drawer')).rejects.toThrow('storage unavailable');
    expect((await runtime.agentService.getSkills()).map(skill => skill.id)).toEqual(before);
    expect(f.resources.drawers.snapshot().some(group => group.name === 'New drawer')).toBe(false);
    const archive = await f.resources.export([], [{ kind: 'skills', name: 'Empty drawer' }]);
    expect(await f.resources.import(archive)).toEqual([]);
    f.workbench.setFilter('skills');
    expect(f.resources.drawers.list('skills')).toContainEqual(expect.objectContaining({ name: 'Empty drawer', paths: [] }));
});

it('exports drawers from their menu, deduplicates selected children and restores deleted drawer organization', async () => {
    const f = await setup();
    const download = vi.spyOn(archiveTransfer, 'downloadArchive').mockImplementation(() => {});
    await f.resources.drawers.assign([{ path: '/skills/phrases', name: '学习' }]); f.workbench.setFilter('skills');
    const group = f.resources.drawers.forPath('/skills/phrases')!;
    f.sidebar.querySelector<HTMLButtonElement>(`[data-item-id="${group.id}"] [data-action="item-menu"]`)!.click();
    expect(document.querySelector('[data-action="deleteDrawer"]')?.textContent).toContain('保留条目');
    document.querySelector<HTMLButtonElement>('[data-action="export-json"]')!.click();
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const exported = download.mock.calls[0][0], archive = JSON.parse(exported);
    expect(archive.drawers).toEqual([{ kind: 'skills', name: '学习' }]);
    expect(archive.entries).toHaveLength(1);
    expect(JSON.parse(await f.workbench.exportSelection([group.id, '/skills/phrases'])).entries).toHaveLength(1);
    await f.resources.drawers.remove(group); f.workbench.setFilter('skills');
    expect(f.resources.drawers.forPath('/skills/phrases')?.name).toBe('未分组');
    const [copy] = await f.resources.import(exported);
    await vi.waitFor(() => expect(f.resources.drawers.forPath(copy)?.name).toBe('学习'));
    expect(await f.resources.sources.skills.driver.exists('/phrases')).toBe(true);
    expect(copy).not.toBe('/skills/phrases');
});
it('reuses the MCP editor confirmation when deleting from the resource list', async () => {
    const f = await setup(); f.workbench.setFilter('mcp');
    f.sidebar.querySelector<HTMLElement>('.vfs-directory-item__header')!.click();
    f.sidebar.querySelector<HTMLButtonElement>('[data-item-id="/mcp/docs"] [data-action="item-menu"]')!.click();
    expect(document.querySelector('[data-action="export-json"]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-action="delete-resource"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    expect((await runtime.agentService.getMCPServers()).some(item => item.id === 'docs')).toBe(true);
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(async () => expect((await runtime.agentService.getMCPServers()).some(item => item.id === 'docs')).toBe(false));
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/mcp/docs"]')).toBeNull());
});
it('exposes provider drawer export and deletion for custom and builtin providers', async () => {
    const f = await setup();
    await runtime.agentService.saveProvider({ baseURL: '', id: 'deletable', name: 'Custom provider', implementation: 'openai-compatible', models: [] });
    await runtime.agentService.saveConnection({ id: 'deletable-connection', name: 'Linked connection', providerId: 'deletable' });
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/model-groups/deletable"]')).not.toBeNull());
    f.workbench.setFilter('models');
    f.sidebar.querySelector<HTMLButtonElement>('[data-item-id="/model-groups/deletable"] [data-action="item-menu"]')!.click();
    expect(document.querySelector('[data-action="export-json"]')).not.toBeNull();
    const archive = JSON.parse(await f.workbench.exportSelection(['/model-groups/deletable']));
    expect(archive.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['providers', 'connections']);
    document.querySelector<HTMLButtonElement>('[data-action="delete-resource"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.llm-delete-impact-section')).not.toBeNull());
    expect(document.querySelector('.settings-modal')?.textContent).toContain('Linked connection');
    expect((await runtime.agentService.getFullProvider('deletable'))).toBeDefined();
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    f.sidebar.querySelector<HTMLButtonElement>('[data-item-id="/model-groups/doubao-speech"] [data-action="item-menu"]')!.click();
    expect(document.querySelector('[data-action="delete-resource"]')).not.toBeNull();
    expect(document.querySelector('[data-action="export-json"]')).not.toBeNull();
});
it('restores an exported long legacy drawer name without applying the new-name input limit', async () => {
    const f = await setup(), name = '旧目录路径 / '.repeat(12);
    const archive = await f.resources.export([], [{ kind: 'skills', name: name.trim() }]);
    await f.resources.import(archive); f.workbench.setFilter('skills');
    expect(f.resources.drawers.list('skills')).toContainEqual(expect.objectContaining({ name: name.trim(), paths: [] }));
});
it('keeps bulk deletion and JSON export for editable files while tool references cannot be deleted', async () => {
    const f = await setup();
    const copied = await f.resources.import(await f.resources.export(['/skills/phrases']));
    await vi.waitFor(async () => expect(await f.resources.sources.skills.driver.exists(copied[0].slice('/skills'.length))).toBe(true));
    await f.workbench.openResource('/skills/phrases');
    await vi.waitFor(() => expect(f.sidebar.querySelector(`[data-item-id="${copied[0]}"]`)).not.toBeNull());
    f.sidebar.querySelector(`[data-item-id="${copied[0]}"] .vfs-node-item__content`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    f.sidebar.querySelector('[data-item-id="/skills/phrases"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(document.querySelector('[data-action="bulk-delete"]')).not.toBeNull();
    expect(document.querySelector('[data-action="export-json"]')).not.toBeNull();
    vi.stubGlobal('confirm', () => true);
    document.querySelector<HTMLButtonElement>('[data-action="bulk-delete"]')!.click();
    await vi.waitFor(async () => expect(await runtime.agentService.getSkills()).toHaveLength(0));
    const tool = '/tools/' + encodeURIComponent([...f.inventory.tools.keys()][0]);
    await f.workbench.openResource(tool);
    f.sidebar.querySelector(`[data-item-id="${tool}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(document.querySelector('[data-action="delete-resource"]')).toBeNull();
    expect(document.querySelector('[data-action="delete"]')).toBeNull();
    expect(document.querySelector('[data-action="export-json"]')).not.toBeNull();
});
it('deletes a provider with the selected default connection and clears the preference', async () => {
    const f = await setup();
    await runtime.agentService.saveProvider({ baseURL: '', id: 'protected-provider', name: 'Protected', implementation: 'openai-compatible', models: [{ id: 'chat', name: 'Chat' }] });
    await runtime.agentService.saveConnection({ id: 'default', name: 'Protected default', providerId: 'protected-provider' });
    await runtime.agentService.setDefaultConnection('default');
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/model-groups/protected-provider"]')).not.toBeNull());
    f.sidebar.querySelector<HTMLButtonElement>('[data-item-id="/model-groups/protected-provider"] [data-action="item-menu"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-action="delete-resource"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(async () => expect((await runtime.agentService.getFullProvider('protected-provider'))).toBeUndefined());
    expect(await runtime.agentService.getDefaultConnection()).toBeNull();
    expect(await runtime.agentService.getFullConnection('default')).toBeNull();
});
it('shows orphan connections separately and restores their original association when the preset is added again', async () => {
    const f = await setup(), service = runtime.agentService;
    await service.deleteProvider('volcengine');
    f.workbench.setFilter('models');
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/invalid-model-connections"]')).not.toBeNull());
    expect(f.sidebar.querySelector('[data-item-id="/model-groups/volcengine"]')).toBeNull();
    await f.workbench.openResource('/connections/conn-volcengine-vision');
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/connections/conn-volcengine-vision"]')).not.toBeNull());
    const path = await f.resources.create('providers', 'Volcengine (火山方舟)', undefined, 'volcengine');
    expect(path).toBe('/providers/volcengine');
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/invalid-model-connections"]')).toBeNull());
    const group = f.sidebar.querySelector<HTMLElement>('[data-item-id="/model-groups/volcengine"]')!;
    group.querySelector<HTMLButtonElement>('[data-action="item-menu"]')!.click();
    expect(document.querySelector('[data-action="provider-settings"]')).not.toBeNull();
    expect(document.querySelector('[data-action="delete-resource"]')).not.toBeNull();
    expect((await service.getConnection('conn-volcengine-vision'))?.providerId).toBe('volcengine');
});

it('lets users cancel or confirm cleanup of orphan connections without restoring the deleted provider', async () => {
    const f = await setup(), service = runtime.agentService;
    await service.deleteProvider('volcengine');
    f.workbench.setFilter('models');
    const menu = () => f.sidebar.querySelector<HTMLButtonElement>('[data-item-id="/invalid-model-connections"] [data-action="item-menu"]');
    await vi.waitFor(() => expect(menu()).not.toBeNull());
    vi.stubGlobal('confirm', () => true);
    const remove = async () => {
        menu()!.click();
        document.querySelector<HTMLButtonElement>('[data-action="delete-invalid-connections"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('.settings-modal')).not.toBeNull());
    };
    await remove();
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    expect(await service.getConnection('conn-volcengine-vision')).toBeDefined();
    await remove();
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(menu()).toBeNull());
    expect(await service.getConnection('conn-volcengine-vision')).toBeUndefined();
    expect(await service.getFullProvider('volcengine')).toBeUndefined();
    expect(await service.getConnection('default')).toBeDefined();
});

it('deletes builtin providers and their connections while retaining independent agents', async () => {
    const f = await setup(), service = runtime.agentService;
    await service.saveConnection({ id: 'cascade-connection', name: 'Cascade connection', providerId: 'volcengine' });
    await service.saveAgent({ id: 'cascade-agent', name: 'Affected agent', type: 'agent', config: {} });
    f.workbench.setFilter('models');
    f.sidebar.querySelector<HTMLButtonElement>('[data-item-id="/model-groups/volcengine"] [data-action="item-menu"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-action="delete-resource"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal')?.textContent).toContain('Cascade connection'));
    expect(document.querySelector('.settings-modal')?.textContent).toContain('Cascade connection');
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal')).toBeNull());
    expect(service.getFullProvider('volcengine')).toBeUndefined();
    expect((await service.getConnections()).filter(connection => connection.providerId === 'volcengine')).toHaveLength(0);
    const agent = (await service.getAgents()).find(item => item.id === 'cascade-agent');
    expect(agent?.config).toEqual({});
    expect((await service.getAgents()).find(item => item.id === 'english')).toBeDefined();
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/model-groups/volcengine"]')).toBeNull());
    const config = await runtime.vfs.openFileSystem('/etc');
    const persisted = JSON.parse(await config.driver.readContent('/llm/.providers/volcengine.json', { encoding: 'utf-8' }));
    expect(persisted.__deleted).toBe(true);
});

it('opens prompts in the toolbox without a second sidebar and preserves multiline segments on save', async () => {
    const f = await setup();
    const content = ['First line\nSecond line', 'Another paragraph'];
    await runtime.agentService.saveSystemPrompt({ id: 'rules', name: 'Shared rules', content });
    await vi.waitFor(() => expect(f.inventory.sources.prompts.driver.exists('/rules')).resolves.toBe(true));
    await f.workbench.openResource('/prompts/rules');
    expect(f.main.querySelector('.settings-split__sidebar')).toBeNull();
    await vi.waitFor(() => expect(f.main.querySelector<HTMLTextAreaElement>('[data-field="content"]')?.value).toBe(content.join('\n')));
    const name = f.main.querySelector<HTMLInputElement>('[data-field="name"]')!; name.value = 'Updated rules';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    name.dispatchEvent(new Event('focusout', { bubbles: true }));
    await vi.waitFor(async () => expect(await runtime.agentService.getSystemPrompt('rules')).toMatchObject({ name: 'Updated rules', content }));
    expect(toolboxSettingsRoute('system-prompts', 'rules')).toBe('/prompts/rules');
});

it('exports shared prompts with their Agent and remaps references on import', async () => {
    const f = await setup();
    await runtime.agentService.saveSystemPrompt({ id: 'rules', name: 'Rules', content: ['One\nTwo', 'Three'], presets: [{ name: 'Check', prompt: 'Check this' }] });
    await runtime.agentService.saveAgent({ id: 'linked', name: 'Linked', type: 'agent', config: { systemPromptId: 'rules', systemPrompt: 'Agent only' } });
    const archive = await f.resources.export(['/agents' + runtime.agentService.getAgentResourceId('linked')]);
    expect(JSON.parse(archive).entries.map((entry: any) => entry.kind)).toEqual(['agents', 'prompts']);
    const paths = await f.resources.import(archive);
    const promptId = paths.find(path => path.startsWith('/prompts/'))!.split('/').pop()!;
    const agent = (await runtime.agentService.getAgents()).find(item => item.id !== 'linked' && item.name === 'Linked')!;
    expect(agent.config).toEqual({ systemPromptId: promptId, systemPrompt: 'Agent only' });
    expect(promptId).not.toBe('rules');
    expect(await runtime.agentService.getSystemPrompt(promptId)).toMatchObject({ content: ['One\nTwo', 'Three'], presets: [{ name: 'Check', prompt: 'Check this' }] });
});

it('orders categories consistently and deletes prompts through the configuration menu', async () => {
    const f = await setup();
    const order = [...f.sidebar.querySelectorAll<HTMLButtonElement>('[data-toolbox-filter]')].map(button => button.dataset.toolboxFilter);
    expect(order).toEqual(['all', 'models', 'flows', 'tools', 'mcp', 'skills', 'prompts', 'agents']);
    expect(f.sidebar.querySelector('[data-toolbox-filter="all"]')?.getAttribute('aria-pressed')).toBe('true');
    f.sidebar.querySelector<HTMLButtonElement>('[data-toolbox-filter="skills"]')!.click();
    expect(f.sidebar.querySelector('[data-toolbox-filter="skills"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(f.sidebar.querySelector('[data-item-id="/drawers/ungrouped-skills"]')).not.toBeNull();
    expect(f.sidebar.querySelector('[data-item-id="/drawers/ungrouped-agents"]')).toBeNull();
    f.sidebar.querySelector<HTMLButtonElement>('[data-toolbox-filter="all"]')!.click();
    const roots = [...f.sidebar.querySelectorAll<HTMLElement>('.vfs-directory-item')].map(item => item.dataset.itemId).filter(Boolean);
    expect(roots.indexOf('/drawers/ungrouped-prompts')).toBeLessThan(roots.indexOf('/drawers/ungrouped-agents'));
    await f.workbench.openResource('/prompts/default');
    f.sidebar.querySelector('[data-item-id="/prompts/default"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="delete-resource"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(async () => expect(await runtime.agentService.getSystemPrompt('default')).toBeNull());
    expect((await runtime.agentService.getAgents()).some(agent => agent.id === 'default')).toBe(true);
    expect((await runtime.agentService.listSystemPrompts()).some(prompt => prompt.id === 'default')).toBe(false);
});

it('remaps prompt references in Flow defaults and nested node configuration', async () => {
    const f = await setup();
    await runtime.agentService.saveSystemPrompt({ id: 'flow-rules', name: 'Flow rules', content: ['Check carefully'] });
    const draft = await runtime.commandBus.execute<any>(FlowCommand.DraftLoad, { id: 'review' });
    await runtime.commandBus.execute(FlowCommand.DraftSave, { draft: { ...draft, defaults: { systemPromptId: 'flow-rules' }, nodes: [
        { id: 'reviewer', name: 'Reviewer', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { systemPromptId: 'flow-rules', instruction: 'Review', approval: 'external' } },
    ] }, expectedDraftVersion: draft.draftVersion });
    const imported = await f.resources.import(await f.resources.export(['/flows/review.flow']));
    const promptId = imported.find(path => path.startsWith('/prompts/'))!.split('/').pop()!;
    const flowId = imported.find(path => path.startsWith('/flows/'))!.split('/').pop()!.replace(/\.flow$/, '');
    const flow = await runtime.commandBus.execute<any>(FlowCommand.DraftLoad, { id: flowId });
    expect(flow.defaults.systemPromptId).toBe(promptId);
    expect(flow.nodes[0].config.systemPromptId).toBe(promptId);
});

it('opens shared model defaults from one toolbar button without loading OCR', async () => {
    const configure = vi.fn().mockResolvedValue(true);
    const f = await setup({ readSettings: async () => ({ value: {}, connections: [] }), saveSettings: async () => {}, openSettings: async () => {}, configure, recognize: async () => '', label: async () => 'OCR', subscribe: () => () => {}, deletionImpact: async () => '' });
    await f.workbench.openResource('/connections');
    const button = f.sidebar.querySelector<HTMLButtonElement>('.vfs-node-list__secondary-action')!;
    expect(button.textContent).toContain(t('modelDefaults.button')); button.click();
    expect(f.navigate).toHaveBeenCalledWith({ target: 'settings', resourceId: 'model-defaults' });
    expect(configure).not.toHaveBeenCalled(); expect(f.sidebar.querySelector('.toolbox-defaults')).toBeNull();
});

it('opens the trusted package manager from the tools category without registering on inspection', async () => {
    const f = await setup(), list = vi.fn(async () => [{id: 'external-package', version: '1', status: 'available' as const, tools: [{id: 'document.inspect'}]}]), ensure = vi.fn();
    Object.defineProperty(f.resources, 'toolPackages', {value: {list, ensure}, configurable: true});
    await f.workbench.openResource('/tools');
    const button = f.sidebar.querySelector<HTMLButtonElement>('.vfs-node-list__secondary-action')!;
    expect(button.textContent).toBe(t('toolbox.packages.title')); button.click();
    await vi.waitFor(() => expect(document.querySelector('[data-package-id="external-package"]')).not.toBeNull());
    expect(list).toHaveBeenCalledOnce(); expect(ensure).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLDialogElement>('.tool-packages-dialog')!;
    dialog.close(); dialog.dispatchEvent(new Event('close')); expect(dialog.isConnected).toBe(false);
});

it('shows dependency issues returned by import instead of treating saved Flow resources as ready', async () => {
    const f = await setup(), report = {flowId: 'imported-flow', name: 'Imported Flow', status: 'missingTools' as const,
        tools: [{id: 'document.inspect', status: 'missing' as const, reason: 'Trusted package is not installed'}], parameters: [], connections: [], errors: []};
    vi.spyOn(archiveTransfer, 'chooseArchive').mockResolvedValue({text: async () => '{}'} as File);
    const imported = vi.spyOn(f.resources, 'importWithReport').mockResolvedValue({paths: [], installations: [report]});
    const legacy = vi.spyOn(f.resources, 'import');
    Object.defineProperty(f.resources, 'flowInstallations', {value: {list: async () => [report], check: vi.fn(), ensure: vi.fn()}, configurable: true});
    f.sidebar.querySelector<HTMLButtonElement>('[data-action="import"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-flow-id="imported-flow"]')?.textContent).toContain('Trusted package is not installed'));
    expect(imported).toHaveBeenCalledWith('{}'); expect(legacy).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLDialogElement>('.tool-packages-dialog')!;
    dialog.close(); dialog.dispatchEvent(new Event('close'));
});

async function selectDrawer(f: Awaited<ReturnType<typeof setup>>, id: string): Promise<void> {
    const kind = f.resources.drawers.get(id)!.kind;
    await f.resources.drawers.assign([], [{ kind, name: 'Second selected drawer' }]);
    f.workbench.setFilter(kind);
    f.sidebar.querySelector<HTMLElement>(`[data-item-id="${id}"] .vfs-directory-item__header`)!.click();
    const second = f.resources.drawers.list(kind).find(group => group.name === 'Second selected drawer')!;
    f.sidebar.querySelector<HTMLElement>(`[data-item-id="${second.id}"] .vfs-directory-item__header`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
}
function deleteSelected(sidebar: HTMLElement): void {
    const button = sidebar.querySelector<HTMLButtonElement>('[data-action="bulk-delete"]')!;
    expect(button.hidden).toBe(false); button.click();
}
it('deletes a selected drawer and all its cards once even when a child is also selected', async () => {
    const f = await setup();
    const [copy] = await f.resources.import(await f.resources.export(['/skills/phrases']));
    await f.resources.drawers.assign([{ path: '/skills/phrases', name: 'Delete me' }, { path: copy, name: 'Delete me' }]);
    f.workbench.setFilter('skills');
    await vi.waitFor(() => expect(f.resources.drawers.forPath(copy)).toBeDefined());
    const group = f.resources.drawers.forPath(copy)!;
    await selectDrawer(f, group.id);
    f.sidebar.querySelector('[data-item-id="/skills/phrases"] .vfs-node-item__content')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    const remove = vi.spyOn(f.resources.sources.skills.driver, 'delete');
    vi.stubGlobal('confirm', () => Promise.resolve(true));
    deleteSelected(f.sidebar);
    await vi.waitFor(() => expect(f.resources.drawers.get(group.id)).toBeUndefined());
    expect(await runtime.agentService.getSkills()).toHaveLength(0);
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0][0]).toHaveLength(2);
});
it('preserves the drawer on cancellation or card deletion failure', async () => {
    const f = await setup();
    await f.resources.drawers.assign([{ path: '/skills/phrases', name: 'Keep me' }]); f.workbench.setFilter('skills');
    const group = f.resources.drawers.forPath('/skills/phrases')!;
    await selectDrawer(f, group.id);
    const confirm = vi.fn().mockResolvedValue(false), alert = vi.fn();
    vi.stubGlobal('confirm', confirm); vi.stubGlobal('alert', alert);
    deleteSelected(f.sidebar);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(f.resources.drawers.get(group.id)).toBeDefined();
    confirm.mockResolvedValue(true);
    vi.spyOn(f.resources.sources.skills.driver, 'delete').mockRejectedValueOnce(new Error('delete failed'));
    deleteSelected(f.sidebar);
    await vi.waitFor(() => expect(alert).toHaveBeenCalled());
    expect(f.resources.drawers.get(group.id)).toBeDefined();
    expect(await f.resources.sources.skills.driver.exists('/phrases')).toBe(true);
});
it('keeps an MCP drawer when its card confirmation is cancelled and removes it after confirmation', async () => {
    const f = await setup();
    await f.resources.drawers.assign([{ path: '/mcp/docs', name: 'Servers' }]); f.workbench.setFilter('mcp');
    const group = f.resources.drawers.forPath('/mcp/docs')!;
    await selectDrawer(f, group.id); vi.stubGlobal('confirm', () => true);
    deleteSelected(f.sidebar);
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-cancel')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal')).toBeNull());
    expect(f.resources.drawers.get(group.id)).toBeDefined();
    deleteSelected(f.sidebar);
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(f.resources.drawers.get(group.id)).toBeUndefined());
    expect(await f.resources.sources.mcp.driver.exists('/docs')).toBe(false);
});
it('deletes empty drawers and excludes tool drawers from bulk deletion', async () => {
    const f = await setup();
    await f.resources.drawers.assign([], [{ kind: 'skills', name: 'Empty' }]); f.workbench.setFilter('skills');
    const group = f.resources.drawers.list('skills').find(group => group.name === 'Empty')!;
    await selectDrawer(f, group.id); vi.stubGlobal('confirm', () => true);
    deleteSelected(f.sidebar);
    await vi.waitFor(() => expect(f.resources.drawers.get(group.id)).toBeUndefined());
    f.workbench.setFilter('tools');
    await selectDrawer(f, f.resources.drawers.list('tools')[0].id);
    expect(f.sidebar.querySelector<HTMLButtonElement>('[data-action="bulk-delete"]')!.hidden).toBe(true);
});
it('deletes selected model drawers through provider impact confirmation including their connections', async () => {
    const f = await setup();
    await runtime.agentService.saveConnection({ id: 'drawer-connection', name: 'Drawer connection', providerId: 'doubao-speech' });
    await vi.waitFor(() => expect(f.inventory.connections.has('drawer-connection')).toBe(true));
    f.workbench.setFilter('models');
    f.sidebar.querySelector<HTMLElement>('[data-item-id="/model-groups/doubao-speech"] .vfs-directory-item__header')!.click();
    f.sidebar.querySelector<HTMLElement>('[data-item-id="/model-groups/volcengine"] .vfs-directory-item__header')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    vi.stubGlobal('confirm', () => true); deleteSelected(f.sidebar);
    await vi.waitFor(() => expect(document.querySelector('.settings-modal')?.textContent).toContain('Drawer connection'));
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/model-groups/doubao-speech"]')).toBeNull());
    expect((await runtime.agentService.getFullProvider('volcengine'))).toBeUndefined();
    expect(await runtime.agentService.getFullConnection('drawer-connection')).toBeNull();
});

it('connects when auto-connect is enabled and updates sidebar state without waiting for a restart', async () => {
    const f = await setup(); await f.workbench.openResource('/mcp/docs');
    const badge = () => f.sidebar.querySelector<HTMLElement>('.mcp-status-icon')!;
    let release!: () => void;
    const connect = vi.spyOn(MCPServerConnection.prototype, 'connect').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    vi.spyOn(MCPServerConnection.prototype, 'isConnected').mockReturnValue(true);
    vi.spyOn(MCPServerConnection.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(MCPServerConnection.prototype, 'discover').mockResolvedValue({ tools: [], resources: [], prompts: [] });
    try {
        await vi.waitFor(() => expect(f.main.querySelector('[name="autoConnect"]')).not.toBeNull());
        const toggle = f.main.querySelector<HTMLInputElement>('[name="autoConnect"]')!;
        toggle.focus();
        toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(badge().title).toContain(t('mcp.state.connecting')), { timeout: 2000 });
        await vi.waitFor(() => expect(f.main.querySelector('[data-mcp-status]')?.textContent).toContain(t('mcp.state.connecting')));
        expect((await runtime.agentService.getMCPServers())[0].autoConnect).toBe(true);
        release(); await vi.waitFor(() => expect(badge().title).toContain(t('mcp.state.connected')));
        await vi.waitFor(() => expect(f.main.querySelector('[data-mcp-status]')?.textContent).toContain(t('status.connected')));
        expect(connect).toHaveBeenCalledOnce(); expect(f.main.querySelector('[name="autoConnect"]')).toBe(toggle);
    } finally { release?.(); }
});

it('updates MCP icon observations after explicit tests without probing during toolbox refresh', async () => {
    const f = await setup();
    await f.workbench.openResource('/mcp/docs');
    const badge = () => f.sidebar.querySelector<HTMLElement>('.mcp-status-icon')!;
    expect(badge().title).toContain(t('mcp.state.idle'));
    const connect = vi.spyOn(MCPServerConnection.prototype, 'connect').mockRejectedValueOnce(new Error('HTTP 401 private-key'));
    const server = (await runtime.agentService.getMCPServers()).find(item => item.id === 'docs')!;
    await expect(runtime.agentService.testMCPServer(server)).rejects.toThrow('401');
    await vi.waitFor(() => expect(badge().title).toContain(t('mcp.failure.authentication')));
    expect(badge().title).not.toContain('private-key');
    expect(connect).toHaveBeenCalledOnce();
    vi.spyOn(MCPServerConnection.prototype, 'discover').mockResolvedValue({tools: [], resources: [], prompts: []});
    vi.spyOn(MCPServerConnection.prototype, 'isConnected').mockReturnValue(true);
    vi.spyOn(MCPServerConnection.prototype, 'disconnect').mockResolvedValue();
    connect.mockResolvedValue(); await runtime.agentService.testMCPServer(server);
    await vi.waitFor(() => expect(badge().title).toContain(t('mcp.state.connected')));
    expect(connect).toHaveBeenCalledTimes(2);
    const exported = JSON.parse(await f.workbench.exportSelection(['/mcp/docs'])).entries[0].data;
    expect(exported.status).toBeUndefined(); expect(exported.connectionState).toBeUndefined();
});

it('imports an external standard bundle with remapped provider references and no credentials', async () => {
    const f = await setup();
    const externalConnections = { format: 'itookit.toolbox', version: 1, entries: [
        { kind: 'providers', data: { id: 'fixture-image', name: 'Image fixture', implementation: 'openai-compatible', baseURL: 'https://example.invalid',
            media: { 'image.generate': { adapter: 'openai-images' } }, models: [{ id: 'image', name: 'Image', category: 'image',
                operations: { 'image.generate': { inputModalities: ['text'], outputModalities: ['image'], formats: ['png'] } } }] } },
        { kind: 'providers', data: { id: 'fixture-speech', name: 'Speech fixture', implementation: 'openai-compatible', baseURL: 'https://example.invalid',
            media: { 'speech.synthesize': { adapter: 'openai-speech' } }, models: [{ id: 'speech', name: 'Speech', category: 'audio',
                operations: { 'speech.synthesize': { inputModalities: ['text'], outputModalities: ['audio'], formats: ['mp3'], voices: ['fixture-voice'] } } }] } },
        { kind: 'connections', data: { id: 'image', name: 'Image connection', providerId: 'fixture-image', tiers: { optimal: 'image' } } },
        { kind: 'connections', data: { id: 'speech', name: 'TTS connection', providerId: 'fixture-speech', tiers: { optimal: 'speech' }, enabled: true } },
    ] };
    const paths = await f.resources.import(JSON.stringify(externalConnections));
    expect(paths).toHaveLength(4);
    const providers = await Promise.all(paths.filter(path => path.startsWith('/providers/')).map(path => runtime.agentService.getFullProvider(path.slice('/providers/'.length))));
    expect(providers).toHaveLength(2); expect(providers.every(provider => !provider?.apiKey)).toBe(true);
    const connections = await Promise.all(paths.filter(path => path.startsWith('/connections/')).map(path => runtime.agentService.getFullConnection(path.slice('/connections/'.length))));
    expect(connections.every(connection => providers.some(provider => provider?.id === connection?.providerId))).toBe(true);
    expect(connections.find(connection => connection?.name.includes('TTS'))?.enabled).toBe(true);
    await vi.waitFor(() => expect([...f.inventory.providers.values()].some(provider => provider.capabilityTags?.includes('image.generate'))).toBe(true));
    expect(providers.some(provider => provider?.id === 'fixture-image')).toBe(false);
});

it('combines capability chips with search, keeps provider groups, and never labels input audio as TTS', async () => {
    const f = await setup();
    await runtime.agentService.saveProvider({id: 'media-filter', name: 'Media fixture', implementation: 'openai-compatible', baseURL: 'https://example.invalid', apiKey: 'private',
        media: {'image.generate': {adapter: 'openai-images'}, 'speech.synthesize': {adapter: 'openai-speech'}}, models: [
            {id: 'picture', name: 'Picture', category: 'image', operations: {'image.generate': {inputModalities: ['text'], outputModalities: ['image'], formats: ['png']}}},
            {id: 'speech', name: 'Speech', category: 'audio', operations: {'speech.synthesize': {inputModalities: ['text'], outputModalities: ['audio'], formats: ['mp3'], voices: ['voice']}}},
            {id: 'ordinary', name: 'Ordinary', supportsAudio: true},
        ]});
    for (const model of ['picture', 'speech', 'ordinary']) await runtime.agentService.saveConnection({id: 'media-' + model, name: 'Media ' + model, providerId: 'media-filter', tiers: {optimal: model}});
    await vi.waitFor(() => expect(f.inventory.connections.get('media-speech')?.capabilityTags).toContain('speech.synthesize'));
    f.workbench.setFilter('models');
    const trigger = f.sidebar.querySelector<HTMLButtonElement>('.workbench-filters__trigger')!;
    expect(trigger.hidden).toBe(false); trigger.click();
    const details = document.querySelector<HTMLElement>('.workbench-filters .toolbox-capabilities')!;
    expect(details.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-capability="image.generate"]')!.click();
    expect(f.sidebar.querySelector('[data-item-id="/connections/media-picture"]')).not.toBeNull();
    expect(f.sidebar.querySelector('[data-item-id="/connections/media-speech"]')).toBeNull();
    const search = f.sidebar.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = 'Media ' + search.value; search.dispatchEvent(new Event('input', {bubbles: true}));
    await vi.waitFor(() => expect(search.value).toContain('Media'));
    document.querySelector<HTMLButtonElement>('.workbench-filters .toolbox-capabilities > button')!.click();
    expect(search.value).toBe('Media');
    document.querySelector<HTMLButtonElement>('[data-capability="speech.synthesize"]')!.click();
    expect(search.value).toBe('Media tag:speech.synthesize');
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(search.value).toBe('Media tag:speech.synthesize');
    expect(f.sidebar.querySelector('[data-item-id="/connections/media-speech"]')).not.toBeNull();
    expect(f.sidebar.querySelector('[data-item-id="/connections/media-ordinary"]')).toBeNull();
    expect(f.sidebar.querySelector('[data-item-id="/connections/media-picture"]')).toBeNull();
    f.workbench.setFilter('skills'); expect(details.hidden).toBe(true);
    f.workbench.setFilter('models'); expect(search.value).toBe('Media tag:speech.synthesize');
    expect(document.querySelector<HTMLButtonElement>('[data-capability="speech.synthesize"]')!.getAttribute('aria-pressed')).toBe('true');
});

it('shows only the primary model capabilities below the connection name and retains routing capabilities for search', async () => {
    const f = await setup();
    await runtime.agentService.saveProvider({id: 'primary-display', name: 'Provider', implementation: 'openai-compatible', baseURL: '', apiKey: 'secret', models: [
        {id: 'main', name: 'Main model', supportsTools: true}, {id: 'vision', name: 'Vision routing', supportsVision: true},
    ]});
    await runtime.agentService.saveConnection({id: 'primary-display', name: 'Only connection name', providerId: 'primary-display', tiers: {optimal: 'main', standard: 'vision'}});
    await vi.waitFor(() => expect(f.inventory.connections.get('primary-display')?.primaryModel).toBe('Main model'));
    expect(f.inventory.connections.get('primary-display')?.capabilityTags).toContain('vision');
    expect(f.inventory.connections.get('primary-display')?.primaryCapabilityTags).not.toContain('vision');
    f.workbench.setFilter('models'); await f.workbench.openResource('/connections/primary-display');
    const row = f.sidebar.querySelector('[data-item-id="/connections/primary-display"]')!;
    expect(row.querySelector('.vfs-node-item__title')?.textContent).toBe('Only connection name');
    expect(row.querySelector('.vfs-node-item__row-primary [role="img"]')).toBeNull();
    const summary = row.querySelector('.vfs-node-item__conn-label')!;
    expect(summary.textContent).toContain('Main model'); expect(summary.textContent).toContain('·');
    expect(summary.querySelector('[aria-label="'+t('toolbox.capability.tools')+'"]')).not.toBeNull();
    expect(summary.querySelector('[aria-label="'+t('toolbox.capability.vision')+'"]')).toBeNull();
    expect(row.querySelector('.vfs-node-item__summary')).toBeNull();
});

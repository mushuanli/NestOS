import { SystemPromptSettingsEditor } from '../../llm-settings-ui/src/editors/SystemPromptSettingsEditor';
// @vitest-environment jsdom
import * as archiveTransfer from '../src/files/archive-transfer';
import { ProviderSettingsEditor } from '../../llm-settings-ui/src/editors/ProviderSettingsEditor';
import { ConnectionSettingsEditor } from '../../llm-settings-ui/src/editors/ConnectionSettingsEditor';
import { toolboxSettingsRoute } from '../src/toolbox/routes';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime, type ApplicationRuntime } from '@itookit/app-core';
import { SkillsEngine } from '@itookit/app-settings';
import { BaseSettingsEditor, editorResourceId, type EditorOptions } from '@itookit/ui-common';
import { MCPSettingsEditor } from '../../llm-settings-ui/src/editors/MCPSettingsEditor';
import { FlowCommand } from '@itookit/llm-session';
import { ToolboxInventory } from '@itookit/app-core';
import { ToolboxResources } from '@itookit/app-core';
import { ToolboxWorkbench } from '../src/toolbox/ToolboxWorkbench';
import { ToolDetailsEditor } from '../src/toolbox/ToolDetailsEditor';
import { legacyToolboxRoute, TOOLBOX_KINDS } from '../src/toolbox/routes';
import { MCPServerConnection } from '../../../backend/kernel-adapters/src/llm-management/skills/mcp-client';
import { t } from '@itookit/common';

let runtime: ApplicationRuntime;
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); await runtime?.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
class Editor extends BaseSettingsEditor<object> { async render() { this.container.textContent = editorResourceId(this.options) ?? ''; } }
async function setup(ocr?: import('../src/configuration/ocr-controls').OcrConfigurationControls,
    uiPreferences?: import('../src/toolbox/ToolboxWorkbench').ToolboxPreferencesPort) {
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
        flows: runtime.flowEngine.engine, ...inventory.sources }, runtime.agentService, runtime.commandBus, await runtime.vfs.openFileSystem('/etc'));
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async (container: HTMLElement, options: EditorOptions) => { const editor = new Editor(container, {}, options); await editor.init(container); return editor; });
    const factories = { prompts: async (container: HTMLElement, options: EditorOptions) => { const editor = new SystemPromptSettingsEditor(container, runtime.agentService, options); await editor.init(container); return editor; }, agents: factory, skills: factory, flows: factory,
        providers: async (container: HTMLElement, options: EditorOptions) => { const editor = new ProviderSettingsEditor(container, runtime.agentService, options); await editor.init(container); return editor; },
        connections: async (container: HTMLElement, options: EditorOptions) => { const editor = new ConnectionSettingsEditor(container, runtime.agentService, options); await editor.init(container); return editor; },
        mcp: async (container: HTMLElement, options: EditorOptions) => { const editor = new MCPSettingsEditor(container, runtime.agentService, options); await editor.init(container); return editor; },
        tools: async (container: HTMLElement, options: EditorOptions) => { const editor = new ToolDetailsEditor(container, inventory, options, resources); await editor.init(container); return editor; } };
    const workbench = new ToolboxWorkbench({ ocr, sidebar, editor: main, resources, inventory, configuration: runtime.configuration, factories, flowMenu: {}, navigate: vi.fn(), selected: vi.fn(), uiPreferences });
    cleanup.push(() => workbench.destroy()); await workbench.start();
    return { workbench, sidebar, main, factory, resources, inventory };
}
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
        expect(await f.resources.sources[kind].driver.exists(imported[i].slice(kind.length + 1))).toBe(true);
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
    ] as const) await runtime.agentService.saveProvider({ baseURL: '', id, name, apiKey, enabled, icon: 'R', implementation: 'openai-compatible', models: [] });
    await runtime.agentService.saveConnection({ id: 'drawer-conn', name: 'A Connection', providerId: 'ready' });
    await vi.waitFor(() => expect(f.inventory.connections.has('drawer-conn')).toBe(true));
    f.workbench.setFilter('models');
    const groups = () => [...f.sidebar.querySelectorAll<HTMLElement>('[data-item-type="directory"]')].map(node => node.dataset.itemId);
    const before = groups();
    expect(before.indexOf('/model-groups/ready')).toBeLessThan(before.indexOf('/model-groups/empty'));
    expect(before.indexOf('/model-groups/empty')).toBeLessThan(before.indexOf('/model-groups/off'));
    await f.workbench.openResource('/connections/drawer-conn');
    const group = () => f.sidebar.querySelector('[data-item-id="/model-groups/ready"]')!;
    expect([...group().querySelectorAll<HTMLElement>('[data-item-type="file"]')].map(node => node.dataset.itemId)).toEqual(['/providers/ready', '/connections/drawer-conn']);
    expect(group().querySelector('.vfs-directory-item__icon')?.textContent).toBe('R');
    expect(group().querySelector('[aria-label="服务商"]')).not.toBeNull();
    expect(group().querySelector('[data-item-id="/connections/drawer-conn"] .vfs-tag-pill')).toBeNull();
    expect(group().querySelector('[data-item-id="/connections/drawer-conn"] [aria-label="模型连接"]')).not.toBeNull();
    expect(f.sidebar.textContent).not.toContain('secret');
    expect(groups()).toEqual(before);
    f.sidebar.querySelector<HTMLButtonElement>('[data-action="create-file"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.project-dialog')).not.toBeNull());
    expect(document.querySelector<HTMLSelectElement>('.project-dialog [name="providerId"]')?.value).toBe('ready');
    document.querySelector<HTMLInputElement>('.project-dialog input')!.value = 'New connection';
    document.querySelector<HTMLFormElement>('.project-dialog form')!.requestSubmit();
    await vi.waitFor(async () => expect((await runtime.agentService.getConnections()).find(c => c.name === 'New connection')?.providerId).toBe('ready'));
    await vi.waitFor(() => expect(group().querySelector('.vfs-directory-item__description')?.textContent).toContain('2 个连接'));
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
    expect(f.main.querySelector<HTMLInputElement>('[name="apiKey"]')?.value).toBe('private-key');
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
    expect(runtime.agentService.getFullProvider(providerId)?.apiKey).toBe('private-key');
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
        dialog.querySelector<HTMLInputElement>('input')!.value = 'Grouped ' + kind;
        dialog.querySelector<HTMLInputElement>('[name="drawer"]')!.value = '学习';
        dialog.querySelector('form')!.requestSubmit();
        const path = await pending;
        const group = f.resources.drawers.forPath(path)!;
        expect(group).toMatchObject({ kind, name: '学习', paths: [path] });
        expect(f.sidebar.querySelector(`[data-item-id="${group.id}"] [data-item-id="${path}"]`)).not.toBeNull();
        expect(await f.resources.sources[kind].driver.exists(path.slice(kind.length + 1))).toBe(true);
        const again = f.workbench.createResource();
        expect(document.querySelector<HTMLInputElement>('.project-dialog [name="drawer"]')?.value).toBe('学习');
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
    expect(document.querySelector<HTMLSelectElement>('.project-dialog [name="kind"]')?.value).toBe('agents');
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
    expect(runtime.agentService.getFullProvider('deletable')).toBeDefined();
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    f.sidebar.querySelector<HTMLButtonElement>('[data-item-id="/model-groups/openai"] [data-action="item-menu"]')!.click();
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
    await runtime.agentService.saveProvider({ baseURL: '', id: 'protected-provider', name: 'Protected', implementation: 'openai-compatible', models: [] });
    await runtime.agentService.saveConnection({ id: 'default', name: 'Protected default', providerId: 'protected-provider' });
    await runtime.agentService.setDefaultConnection('default');
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/model-groups/protected-provider"]')).not.toBeNull());
    f.sidebar.querySelector<HTMLButtonElement>('[data-item-id="/model-groups/protected-provider"] [data-action="item-menu"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-action="delete-resource"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(runtime.agentService.getFullProvider('protected-provider')).toBeUndefined());
    expect(await runtime.agentService.getDefaultConnection()).toBeNull();
    expect(await runtime.agentService.getFullConnection('default')).toBeNull();
});
it('deletes builtin providers and their connections while retaining independent agents', async () => {
    const f = await setup(), service = runtime.agentService;
    await service.saveConnection({ id: 'cascade-connection', name: 'Cascade connection', providerId: 'anthropic' });
    await service.saveAgent({ id: 'cascade-agent', name: 'Affected agent', type: 'agent', config: {} });
    f.workbench.setFilter('models');
    f.sidebar.querySelector<HTMLButtonElement>('[data-item-id="/model-groups/anthropic"] [data-action="item-menu"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-action="delete-resource"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal')?.textContent).toContain('Cascade connection'));
    expect(document.querySelector('.settings-modal')?.textContent).toContain('Cascade connection');
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal')).toBeNull());
    expect(service.getFullProvider('anthropic')).toBeUndefined();
    expect((await service.getConnections()).filter(connection => connection.providerId === 'anthropic')).toHaveLength(0);
    const agent = (await service.getAgents()).find(item => item.id === 'cascade-agent');
    expect(agent?.config).toEqual({});
    expect((await service.getAgents()).find(item => item.id === 'english')).toBeDefined();
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/model-groups/anthropic"]')).toBeNull());
    const config = await runtime.vfs.openFileSystem('/etc');
    const persisted = JSON.parse(await config.driver.readContent('/llm/.providers/anthropic.json', { encoding: 'utf-8' }));
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
    const order = [...f.sidebar.querySelectorAll<HTMLButtonElement>('[data-filter]')].map(button => button.dataset.filter);
    expect(order).toEqual(['all', 'agents', 'flows', 'skills', 'prompts', 'tools', 'mcp', 'models']);
    const roots = [...f.sidebar.querySelectorAll<HTMLElement>('.vfs-directory-item')].map(item => item.dataset.itemId).filter(Boolean);
    expect(roots.indexOf('/drawers/ungrouped-agents')).toBeLessThan(roots.indexOf('/drawers/ungrouped-prompts'));
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

it('opens shared OCR configuration from the models toolbar', async () => {
    const configure = vi.fn().mockResolvedValue(true);
    const f = await setup({ readSettings: async () => ({ value: {}, connections: [] }), saveSettings: async () => {}, openSettings: async () => {}, configure, recognize: async () => '', label: async () => 'OCR', subscribe: () => () => {}, deletionImpact: async () => '' });
    await f.workbench.openResource('/connections');
    const button = [...f.sidebar.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('文字识别设置'));
    expect(button).toBeDefined(); button!.click(); expect(configure).toHaveBeenCalledOnce();
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
    await runtime.agentService.saveConnection({ id: 'drawer-connection', name: 'Drawer connection', providerId: 'openai' });
    await vi.waitFor(() => expect(f.inventory.connections.has('drawer-connection')).toBe(true));
    f.workbench.setFilter('models');
    f.sidebar.querySelector<HTMLElement>('[data-item-id="/model-groups/openai"] .vfs-directory-item__header')!.click();
    f.sidebar.querySelector<HTMLElement>('[data-item-id="/model-groups/anthropic"] .vfs-directory-item__header')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    vi.stubGlobal('confirm', () => true); deleteSelected(f.sidebar);
    await vi.waitFor(() => expect(document.querySelector('.settings-modal')?.textContent).toContain('Drawer connection'));
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(f.sidebar.querySelector('[data-item-id="/model-groups/openai"]')).toBeNull());
    expect(runtime.agentService.getFullProvider('anthropic')).toBeUndefined();
    expect(await runtime.agentService.getFullConnection('drawer-connection')).toBeNull();
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

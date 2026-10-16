// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '@itookit/app-core';
import { RpcPeer, installViewProjections } from '@itookit/app-transport/application';
import { createHostedView } from '@itookit/node-host/http';
import { TOOLBOX_KINDS } from '@itookit/app-contracts';
import { ToolboxWorkbench } from '../src/toolbox/ToolboxWorkbench';

it('renders and refreshes prepared toolbox data without frontend filesystem callbacks or directory probes', async () => {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false });
    const view = await createHostedView(runtime);
    const methods: string[] = [], reverseReads: string[] = [];
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => { methods.push(call.method); return server.handle(call); }, console.error, installViewProjections);
    server = new RpcPeer('server', async call => {
        if (!call.notification) reverseReads.push(call.method);
        client.applyUpdates(await server.refresh()); return client.handle(call);
    }, console.error, undefined, domains => view.prepare(server, domains));
    let workbench: ToolboxWorkbench | undefined;
    try {
        await runtime.agentService.saveSkill({ id: 'skill', name: 'Prepared skill', description: '', type: 'prompt', enabled: false,
            instructions: 'test', tools: [], triggerPatterns: [], autoLoad: false, priority: 1 });
        const root = client.decode(await server.expose(view.root)); client.applyUpdates(await server.refresh());
        const toolbox = await root.backend.toolboxView();
        const sidebar = document.createElement('div'), editor = document.createElement('div'); document.body.append(sidebar, editor);
        const factories = Object.fromEntries(TOOLBOX_KINDS.map(kind => [kind, vi.fn()])) as never;
        workbench = new ToolboxWorkbench({ sidebar, editor, ...toolbox, factories, configuration: root.services.configuration,
            flowMenu: {}, navigate: vi.fn(), selected: vi.fn() });
        await workbench.start();
        sidebar.querySelector<HTMLElement>('[data-item-id="/drawers/ungrouped-skills"] .vfs-directory-item__header')!.click();
        expect(methods.filter(method => method === 'toolboxView')).toHaveLength(1);
        expect(methods).not.toContain('navigation');
        expect(methods).not.toContain('getChildren'); expect(methods).not.toContain('getNodeType');
        expect(reverseReads).toEqual([]);
        expect(toolbox.initial.directories.find((entry: {path: string}) => entry.path === '/skills').nodes[0].metadata.title).toBe('Prepared skill');
        const skill = (await runtime.agentService.getSkills()).find(item => item.id === 'skill')!;
        await runtime.agentService.saveSkill({ ...skill, name: 'Updated prepared skill' });
        await vi.waitFor(() => expect(methods).toContain('navigation'));
        await vi.waitFor(() => expect(sidebar.textContent).toContain('Updated prepared skill'));
        expect(reverseReads).toEqual([]);
        expect(methods).not.toContain('getChildren'); expect(methods).not.toContain('getNodeType');
        const skills = await root.backend.skillsFiles();
        expect((await skills.driver.getChildren('/')).some((node: {metadata: {title: string}}) => node.metadata.title === 'Updated prepared skill')).toBe(true);
        expect(reverseReads).toEqual([]);
    } finally {
        await workbench?.destroy(); await client.close(); await server.close(); await view.close(); await runtime.dispose();
        document.body.replaceChildren();
    }
});

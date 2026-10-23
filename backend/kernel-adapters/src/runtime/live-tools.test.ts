import {expect, it} from 'vitest';
import {buildTool} from '@itookit/tools';
import type {IDeviceDriver} from '@itookit/vfs-core';
import {createKernelAdaptersRuntime} from './create-kernel-adapters-runtime';

function tool(name: string, description = 'A dynamically installed fixture') {
    return buildTool({name, version: '1', isReadOnly: () => true, description: async () => description,
        inputSchema: {safeParse: (data: unknown) => ({success: true, data})} as never,
        call: async () => ({data: 'ready'})});
}

it('publishes installed tools to the live metadata catalog, active scopes and future scopes', async () => {
    const runtime = await createKernelAdaptersRuntime({llmDriver: {} as IDeviceDriver});
    try {
        const active = await runtime.sessions.get('before'), addition = tool('fixture.live');
        await Promise.all([runtime.registerTools([addition]), runtime.registerTools([addition])]);
        expect(runtime.toolCatalog.getToolMeta('fixture.live')).toMatchObject({version: '1', description: 'A dynamically installed fixture'});
        expect(active.toolService.getToolDefinitions().some(item => item.function?.name === 'fixture.live')).toBe(true);
        expect(await active.toolService.invoke({toolId: 'fixture.live', args: {}, toolVersion: '1', resultMode: 'structured'})).toMatchObject({success: true, data: 'ready'});
        expect((await runtime.sessions.get('after')).toolService.getToolMeta('fixture.live')?.version).toBe('1');
        await expect(runtime.registerTools([tool('fixture.live')])).rejects.toMatchObject({code: 'TOOL_PACKAGE_TOOL_CONFLICT'});
    } finally {await runtime.dispose();}
});

it('validates all additions before publishing any new metadata or executable', async () => {
    const runtime = await createKernelAdaptersRuntime({llmDriver: {} as IDeviceDriver});
    try {
        const active = await runtime.sessions.get('before'), broken = tool('fixture.broken');
        broken.description = async () => {throw new Error('private module detail');};
        await expect(runtime.registerTools([tool('fixture.first'), broken])).rejects.toThrow('private module detail');
        expect(runtime.toolCatalog.getToolMeta('fixture.first')).toBeUndefined();
        expect(active.toolService.getToolMeta('fixture.first')).toBeUndefined();
        await runtime.registerTools([tool('fixture.recovered')]);
        expect(active.toolService.getToolMeta('fixture.recovered')?.enabled).toBe(true);
    } finally {await runtime.dispose();}
});

it('prepares every driver metadata copy before publishing a batch containing malformed JavaScript metadata', async () => {
    const runtime = await createKernelAdaptersRuntime({llmDriver: {} as IDeviceDriver});
    try {
        const active = await runtime.sessions.get('before'), invalid = tool('fixture.invalid');
        invalid.description = async () => (() => 'invalid serializable metadata') as never;
        await expect(runtime.registerTools([tool('fixture.first'), invalid])).rejects.toThrow();
        for (const id of ['fixture.first', 'fixture.invalid']) {
            expect(runtime.toolCatalog.getToolMeta(id)).toBeUndefined(); expect(active.toolService.getToolMeta(id)).toBeUndefined();
            expect((await runtime.sessions.get('after')).toolService.getToolMeta(id)).toBeUndefined();
        }
    } finally {await runtime.dispose();}
});

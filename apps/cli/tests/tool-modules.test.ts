import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadNodeToolModules } from '@itookit/node-host/runtime';
import { ToolDeviceDriver } from '@itookit/tools';

it('loads explicitly configured external tools with host schemas and rejects duplicate identities', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-modules-'));
    try {
        const module = path.join(root, 'tools.mjs');
        await writeFile(module, `export function createTools({buildTool,z}) {return [buildTool({name:'fixture.convert',version:'1',inputSchema:z.object({value:z.string()}),isReadOnly:()=>true,maxResultSizeChars:1000,description:async()=>'',prompt:async()=>'',call:async args=>({data:{value:args.value}}),mapToolResultToToolResultBlockParam:(data,id)=>({type:'tool_result',tool_use_id:id,content:JSON.stringify(data)})})]}`);
        const tools = await loadNodeToolModules(JSON.stringify([module]));
        const driver = new ToolDeviceDriver(tools); await driver.init();
        expect(await driver.invoke({ toolId: 'fixture.convert', args: { value: 'hello' }, resultMode: 'structured', toolVersion: '1' }))
            .toMatchObject({ success: true, data: { value: 'hello' } });
        await expect(loadNodeToolModules(JSON.stringify([module, module]))).rejects.toThrow('duplicate');
        await expect(loadNodeToolModules('["relative.mjs"]')).rejects.toThrow('absolute');
        expect(await loadNodeToolModules('')).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

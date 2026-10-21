import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it, vi} from 'vitest';
import {validateCommand} from '../src/commands';
it('checks user Flow sources offline and reports errors with nonzero status', async()=>{
    const root=await mkdtemp(join(tmpdir(),'flow-check-')), file=join(root,'test.flow');
    const output=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    try {
        await writeFile(file,'{\n"id": !}');
        expect(await validateCommand({file,json:true})).toBe(1);
        expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({valid:false,diagnostics:[expect.objectContaining({code:'parse-error',line:2})]});
        await writeFile(file,JSON.stringify({id:'test',name:'Test',draftVersion:1,edges:[],nodes:[{id:'a',name:'A',plugin:'builtin.transform',pluginVersion:'1.0.0',inputs:{},config:{value:1}}]}));
        expect(await validateCommand({file,json:true})).toBe(0);
        expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual({valid:true,diagnostics:[]});
    }finally {output.mockRestore();await rm(root,{recursive:true,force:true});}
});

it('rejects invalid sibling Flow arguments offline and accepts a corrected invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flow-call-check-')), file = join(root, 'parent.flow');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const child = { id: 'child', name: 'Child', draftVersion: 1, parameters: [{ name: 'word', type: 'string', required: true }],
        nodes: [{ id: 'work', name: 'Work', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 1 } }],
        edges: [], outputs: { result: { value: '${nodes.work.outputs.result}' } } };
    const parent = { id: 'parent', name: 'Parent', draftVersion: 1, edges: [], nodes: [{
        id: 'call', name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
        config: { flowId: 'child', parameters: {} as Record<string, unknown> },
    }] };
    try {
        await writeFile(join(root, 'child.flow'), JSON.stringify(child));
        for (const parameters of [{ wrod: 'hello' }, {}, { word: 42 }]) {
            parent.nodes[0].config.parameters = parameters;
            await writeFile(file, JSON.stringify(parent));
            expect(await validateCommand({ file, json: true })).toBe(1);
            expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ valid: false });
        }
        parent.nodes[0].config.parameters = { word: 'hello' };
        await writeFile(file, JSON.stringify(parent));
        expect(await validateCommand({ file, json: true })).toBe(0);
    } finally { output.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

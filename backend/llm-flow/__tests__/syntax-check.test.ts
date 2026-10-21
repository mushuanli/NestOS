import {describe, expect, it} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {checkFlowSource, checkFlowSyntax} from '../src/flow/syntax-check';
import {validateSchema} from '../src/flow/validation';
const draft = () => ({id:'example', name:'Example', draftVersion:1, updatedAt:0,
    parameters:[{name:'word', type:'string', default:'hello'}],
    nodes:[{id:'a', name:'A', plugin:'builtin.transform', pluginVersion:'1.0.0', inputs:{}, config:{value:'${param.word}'}}], edges:[]});

describe('Flow source checks', () => {
    it.each([
        ['required', 'yes', '$.connections[0].required'],
        ['tier', 'typo', '$.connections[0].tier'],
        ['requirements', {operation: 'chat', inputModalities: 'image'}, '$.connections[0].requirements.inputModalities'],
    ])('checks connection contract field %s without needing installed connections', (field, value, path) => {
        const source = {...draft(), connections: [{name: 'vision', [field]: value}]};
        expect(checkFlowSyntax(source).diagnostics).toContainEqual(expect.objectContaining({path, code: 'invalid-shape'}));
    });
    it('reports unknown named slots and conflicting declared operations at their nodes', () => {
        const source = {...draft(), connections: [{name: 'vision', requirements: {operation: 'chat'}}]};
        source.nodes[0].config = {connectionSlot: 'missing'} as never;
        expect(checkFlowSyntax(source).diagnostics).toContainEqual(expect.objectContaining({code: 'unknown-connection-slot', nodeId: 'a'}));
        source.nodes[0].config = {connectionSlot: 'vision', connectionRequirements: {operation: 'image.generate'}} as never;
        expect(checkFlowSyntax(source).diagnostics).toContainEqual(expect.objectContaining({code: 'connection-requirements-conflict', nodeId: 'a'}));
    });
    it('checks JSON drafts and returns diagnostics without executing anything', () => {
        expect(checkFlowSyntax(JSON.stringify(draft()))).toMatchObject({valid:true, diagnostics:[], flow:{id:'example',revision:1}});
    });
    it.each(['off', 'max', 'provider_level-1'])('accepts model-defined reasoning effort %s before model admission', reasoningEffort => {
        const flow = draft(); flow.nodes[0] = {...flow.nodes[0], plugin: 'builtin.agent', config: {reasoningEffort}} as never;
        expect(checkFlowSyntax(flow)).toMatchObject({valid: true});
    });
    it.each(['', 'invalid effort', 'x'.repeat(65)])('rejects malformed reasoning effort %j', reasoningEffort => {
        const flow = draft(); flow.nodes[0] = {...flow.nodes[0], plugin: 'builtin.agent', config: {reasoningEffort}} as never;
        expect(checkFlowSyntax(flow)).toMatchObject({valid: false});
    });
    it.each([null, [], 3, {}, {nodes:[null],edges:[]}])('rejects an untrusted shape without throwing: %j', value => {
        expect(checkFlowSyntax(value)).toMatchObject({valid:false});
    });
    it('reports parser line and column and supports injected parsers', () => {
        expect(checkFlowSyntax('{\n"id": !}').diagnostics[0]).toMatchObject({code:'parse-error',line:2,column:7});
        expect(checkFlowSyntax('yaml', {parse:()=>draft()}).valid).toBe(true);
        expect(checkFlowSyntax('yaml', {parse:()=>{throw {mark:{line:2,column:3}};}}).diagnostics[0]).toMatchObject({line:3,column:4});
    });
    it('rejects duplicate JSON properties and attaches locations to semantic diagnostics', () => {
        expect(checkFlowSyntax('{"id":"a","id":"b"}').diagnostics[0]).toMatchObject({code:'parse-error',line:1});
        const flow = draft(); flow.parameters[0].name = '';
        expect(checkFlowSyntax(JSON.stringify(flow,null,2)).diagnostics[0]).toMatchObject({code:'invalid-shape',line:expect.any(Number)});
    });
    it('finds unknown plugins, invalid configuration and missing producers', () => {
        const flow = draft(); flow.nodes[0].plugin = 'unknown';
        expect(checkFlowSyntax(flow).diagnostics.some(issue=>issue.code==='unknown-plugin')).toBe(true);
        flow.nodes[0].plugin = 'builtin.agent'; flow.nodes[0].config = {value:undefined} as never;
        (flow.nodes[0].config as Record<string,unknown>).approval='typo';
        expect(checkFlowSyntax(flow).diagnostics.some(issue=>issue.code==='invalid-config' && issue.path==='$.nodes[0]')).toBe(true);
        flow.nodes[0].config = {value:'${nodes.missing.outputs.result}'};
        expect(checkFlowSyntax(flow).valid).toBe(false);
    });
    it('finds undeclared parameters while preserving literal message history', () => {
        const flow = draft(); flow.nodes[0].config.value='${param.typo}';
        expect(checkFlowSyntax(flow).diagnostics).toContainEqual(expect.objectContaining({code:'unknown-parameter',path:'$.nodes[0]'}));
        flow.nodes[0].config = {value:'hello', messages:[{role:'user',content:'${param.literal}'}]} as never;
        expect(checkFlowSyntax(flow).valid).toBe(true);
    });
    it('rejects misspelled edge kinds and permits nullable JSON defaults', () => {
        const flow = draft();
        (flow as Record<string,unknown>).edges = [{id:'bad',from:'a',to:'a',kind:'contrlo'}];
        expect(checkFlowSyntax(flow).diagnostics.some(issue=>issue.path==='$.edges[0].kind')).toBe(true);
        expect(checkFlowSyntax({...draft(),parameters:[{name:'word',type:'json',default:null}]}).valid).toBe(true);
    });
    it('preserves legacy data edges while recommending explicit kinds', () => {
        const flow = draft(); flow.nodes.push({...flow.nodes[0],id:'b'});
        const result = checkFlowSyntax({...flow,edges:[{id:'a-b',from:'a',to:'b',output:'result',input:'input'}]});
        expect(result).toMatchObject({valid:true, diagnostics:[expect.objectContaining({code:'implicit-edge-kind',severity:'warning'})]});
    });
    it('checks duplicate fields, widget contracts and defaults', () => {
        const flow = draft(); flow.parameters.push({...flow.parameters[0]});
        expect(checkFlowSyntax(flow).diagnostics.some(issue=>issue.code==='duplicate-parameter')).toBe(true);
        flow.parameters = [{name:'word', type:'number', default:'bad'}];
        expect(checkFlowSyntax(flow).diagnostics.some(issue=>issue.code==='invalid-default')).toBe(true);
        (flow.parameters[0] as Record<string,unknown>).widget='images';
        expect(checkFlowSyntax(flow).diagnostics.some(issue=>issue.code==='invalid-parameter')).toBe(true);
    });
    it('checks nested calls offline, missing children and composition cycles', async () => {
        const parent = draft(); parent.nodes[0] = {...parent.nodes[0], plugin:'builtin.flow', pluginVersion:'2.0.0', config:{flowId:'child'}} as never;
        expect(await checkFlowSource(parent,{resolveComposite:async()=>null})).toMatchObject({valid:false,diagnostics:[expect.objectContaining({code:'invalid-composition'})]});
        const child = checkFlowSyntax({...draft(), id:'child',outputs:{result:{value:'${nodes.a.outputs.result}'}}}).flow!;
        expect((await checkFlowSource(parent,{resolveComposite:async()=>child})).valid).toBe(true);
        const cycle = checkFlowSyntax({...parent,id:'child'}).flow!;
        expect((await checkFlowSource(parent,{resolveComposite:async()=>cycle})).valid).toBe(false);
    });
    it('accepts every recoverable catalog Flow', () => {
        const root = new URL('../../app-core/src/presets/',import.meta.url);
        for (const name of readdirSync(root).filter(name=>name.endsWith('.json'))) {
            const flow = JSON.parse(readFileSync(new URL(name,root),'utf8'));
            if (flow.nodes) expect(checkFlowSyntax(flow),name).toMatchObject({valid:true});
        }
    });
});

it('checks nested schema enums, arrays, object properties and numeric bounds', () => {
    expect(validateSchema({type:'object',additionalProperties:false,properties:{mode:{enum:['gray']}, count:{type:'integer',minimum:1}, items:{type:'array',items:{type:'string'}}}},
        {mode:'typo',count:0,items:[1],extra:true})).toEqual(expect.arrayContaining(['$.mode is outside enum','$.count is outside numeric range','$.items[0] must be string','$.extra is forbidden']));
    expect(validateSchema({enum:['gray']},'${nodes.process.outputs.result}')).toEqual([]);
});

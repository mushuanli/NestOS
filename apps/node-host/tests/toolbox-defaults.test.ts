import {expect,it} from 'vitest';
import {z} from 'zod/v4';
import type {Tool} from '@itookit/tools';
import {toolboxParameters} from '../src/runtime/tool-packages/toolbox';
it('projects schema defaults and offers only matching user connections without guessing among accounts',()=>{
 const tool={inputSchema:z.object({query:z.string().default('recent'),maxItems:z.number().int().default(100),connection:z.string()})} as unknown as Tool;
 const fields=[{name:'query'},{name:'maxItems'},{name:'connection',connectionType:'google'}];
 const connections=[{id:'mine',type:'google',name:'My account',values:{},configuredSecrets:[]}];
 const parameters=toolboxParameters(tool,fields,connections);
 expect(parameters[0].default).toBe('recent');expect(parameters[1].default).toBe(100);
 expect(parameters[2]).toMatchObject({widget:'select',options:['mine'],default:'mine'});
 const multiple=toolboxParameters(tool,fields,[...connections,{...connections[0],id:'work'}]);
 expect(multiple[2].options).toEqual(['mine','work']);expect(multiple[2].default).toBeUndefined();
 expect(toolboxParameters(tool,fields,[{...connections[0],type:'other'}])[2].options).toEqual([]);
});

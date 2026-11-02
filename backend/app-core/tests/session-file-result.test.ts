import {afterEach,expect,it} from 'vitest';
import {createVFS,MemoryBackend} from '@itookit/vfs-core';
import {readSessionFileResult} from '../src/run/session-file-result';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),entries=new Map<string,unknown>();
    const journal={get:async<T>(key:string)=>entries.get(key) as T|undefined,update:async<T>(key:string,change:(old:T|undefined)=>T)=>{const next=change(entries.get(key) as T|undefined);entries.set(key,next);return next;}};
    const write=async(content:string)=>{if(await fs.driver.exists('/result.yaml'))await fs.driver.writeContent('/result.yaml',content);else await fs.driver.createFile({parentPath:'/',name:'result.yaml',content});};
    return {fs,journal,write,read:()=>readSessionFileResult(fs,'/result.yaml','operation',journal)};
}
it('reads YAML files independently of session text and rejects changed publications',async()=>{
    const f=await fixture();expect(await f.read()).toBeUndefined();
    await f.write('schema: nestos.file-result/1\noperationId: operation\npayload:\n  ready: true\n');
    expect(await f.read()).toEqual({ready:true});expect(await f.read()).toEqual({ready:true});
    await f.write('schema: nestos.file-result/1\noperationId: operation\npayload: changed');
    await expect(f.read()).rejects.toMatchObject({code:'SESSION_FILE_RESULT_CHANGED'});
});
it('rejects mismatched scope, custom YAML types and recursive aliases',async()=>{
    const f=await fixture();await f.write('schema: nestos.file-result/1\noperationId: other\npayload: {}');
    await expect(f.read()).rejects.toMatchObject({code:'SESSION_FILE_RESULT_SCOPE_MISMATCH'});
    await f.write('!!js/function function(){}');await expect(f.read()).rejects.toMatchObject({code:'SESSION_FILE_RESULT_INVALID'});
    await f.write('a: &a [*a]');await expect(f.read()).rejects.toMatchObject({code:'SESSION_FILE_RESULT_INVALID'});
});

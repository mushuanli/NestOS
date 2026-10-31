import {expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@itookit/vfs-core';
import {createStudyHost} from '../src/study';
it('provides empty and nested save directories independently of the sparse learning index',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
 try{
  await fs.driver.createDirectory({parentPath:'/',name:'empty'});await fs.driver.createDirectory({parentPath:'/empty',name:'nested'});await fs.driver.createDirectory({parentPath:'/',name:'.internal'});
  await fs.driver.createFile({parentPath:'/',name:'unopened.md',content:'--not tracked--'});
  const read=vi.spyOn(fs.driver,'readContent'),host=createStudyHost(fs,async()=>{},{creation:{documents: {save: async()=>{}}}});
  expect(await host.list()).toEqual([]);expect(read).not.toHaveBeenCalled();
  const directories=host.creation!.documents.directories!;
  const entries=await directories.list();expect(entries).toContainEqual({id:'/empty',title:'empty',kind:'directory'});expect(entries.some(entry=>entry.id==='/.internal'||entry.id==='/unopened.md')).toBe(false);
  expect(await directories.list('/empty')).toEqual([{id:'/empty/nested',title:'nested',kind:'directory'}]);
  expect(read).not.toHaveBeenCalled();expect(await fs.driver.exists('/.nestos/cloze-srs.seq')).toBe(false);
  const controller=new AbortController();controller.abort();await expect(directories.list('/',controller.signal)).rejects.toMatchObject({name:'AbortError'});
 }finally{await manager.dispose();}
});
it('propagates a concrete directory read failure to the picker',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
 try{
  const host=createStudyHost(fs,async()=>{},{creation:{documents: {save: async()=>{}}}});
  const read=vi.spyOn(fs.driver,'getChildren').mockRejectedValueOnce(Object.assign(new Error('Directory denied'),{code:'EACCES'}));
  await expect(host.creation!.documents.directories!.list()).rejects.toMatchObject({code:'EACCES'});read.mockRestore();
 }finally{await manager.dispose();}
});

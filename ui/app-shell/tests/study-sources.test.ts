import {expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@itookit/vfs-core';
import {studySources} from '../src/browser/study-sources';
import type {ApplicationServices} from '@itookit/app-contracts/services';
it('finds documents across workspaces and projects by all keywords and reads only allowed sources',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});
 try {
  const notes=await manager.openFileSystem('/notes'),project=await manager.openFileSystem('/project');
  await notes.driver.createFile({parentPath:'/',name:'biology.md',content:'Notes',recursive:true});
  await project.driver.createFile({parentPath:'/biology',name:'lever.txt',content:'Project material',recursive:true});
  await project.driver.createFile({parentPath:'/level1/level2/level3',name:'deep.txt',content:'Deep material',recursive:true});
  await project.driver.createFile({parentPath:'/.nestos',name:'secret.md',content:'Private',recursive:true});
  const dispose=vi.fn(async()=>{}),openFiles=vi.fn(async()=>({fs:project,dispose})),services={projects:{list:async()=>[{path:'/School',name:'School',project:{id:'school'}}],openFiles}} as unknown as ApplicationServices;
  const provider=studySources(services,[{id:'notes',label:'Notes',files:async()=>notes}]),signal=new AbortController().signal;
  const roots=await provider.search('SCHOOL',signal);expect(roots).toHaveLength(1);expect(roots[0].kind).toBe('directory');expect(openFiles).not.toHaveBeenCalled();
  const matches=await provider.search('SCHOOL biology lever',signal,roots[0].id);expect(matches).toHaveLength(1);
  expect(await provider.read(matches[0].id,signal)).toBe('Project material');expect(dispose).toHaveBeenCalledTimes(2);
  expect(await provider.search('deep',signal,roots[0].id)).toEqual([]);
  const folders=await provider.search('',signal,roots[0].id);const first=folders.find(item=>item.label.endsWith('/level1'))!;expect(first.kind).toBe('directory');
  expect((await provider.search('deep',signal,first.id)).some(item=>item.label.endsWith('/deep.txt'))).toBe(true);
  expect((await provider.search('',signal)).map(item=>item.label)).toEqual(['Notes','School']);
  await expect(provider.read(JSON.stringify(['project:school','/.nestos/secret.md']),signal)).rejects.toMatchObject({code:'SOURCE_INVALID'});
  await expect(provider.read(JSON.stringify(['workspace:outside','/secret.md']),signal)).rejects.toMatchObject({code:'SOURCE_INVALID'});
 }finally{await manager.dispose();}
});

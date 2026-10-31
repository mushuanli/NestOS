import {expect,it} from 'vitest';
import {createVFS,MemoryBackend} from '@itookit/vfs-core';
import {createStudyPromptStore} from '../src/study-prompt';
it('keeps reads lazy and persists only the explicitly saved prompt separately from SRS records',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
 try{
  const store=createStudyPromptStore(fs),signal=new AbortController().signal;
  expect(await store.list!(signal)).toBeUndefined();expect(await store.load(signal)).toBeUndefined();expect(await fs.driver.exists('/.nestos')).toBe(false);
  await store.save('first prompt');expect(await store.load(signal)).toBe('first prompt');
  await store.save('edited prompt');expect(await fs.driver.readContent('/.nestos/cloze/prompt.md',{encoding:'utf-8'})).toBe('edited prompt');
  await store.saveList!([{id:'one',name:'背单词',content:'template'}]);
  expect(await store.list!(signal)).toEqual([{id:'one',name:'背单词',content:'template'}]);
  await fs.driver.writeContent('/.nestos/cloze/prompts.yaml', '[{}]');
  await expect(store.list!(signal)).rejects.toMatchObject({code:'INVALID_PROMPT_LIST'});
  expect(await fs.driver.exists('/.nestos/cloze-srs.seq')).toBe(false);
 }finally{await manager.dispose();}
});
it('ignores old JSON and saves multiline templates as YAML',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
 try {
  const entries=[{id:'custom',name:'Mine',content:'First line\nSecond line\n'}];
  await fs.driver.createFile({parentPath:'/.nestos/cloze',name:'prompts.json',content:JSON.stringify(entries),recursive:true});
  const store=createStudyPromptStore(fs),signal=new AbortController().signal;
  expect(await store.list!(signal)).toBeUndefined();expect(await fs.driver.exists('/.nestos/cloze/prompts.yaml')).toBe(false);
  await store.saveList!(entries);expect(await store.list!(signal)).toEqual(entries);
  expect(String(await fs.driver.readContent('/.nestos/cloze/prompts.yaml',{encoding:'utf-8'}))).toContain('content: |');
 }finally{await manager.dispose();}
});

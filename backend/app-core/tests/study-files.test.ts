import yaml from 'js-yaml';
import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {seedStudyFiles} from '../src/presets/study-files';
it('retains legacy prompts when initializing the named collection',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
 try {
  await fs.driver.createFile({parentPath:'/.nestos/cloze',name:'prompt.md',content:'My old prompt',recursive:true});
  await seedStudyFiles(fs);
  const prompts=yaml.load(String(await fs.driver.readContent('/.nestos/cloze/prompts.yaml',{encoding:'utf-8'}))) as Array<{id:string;name:string;content:string}>;
  expect(prompts[0]).toMatchObject({id:'legacy',content:'My old prompt'});expect(prompts).toHaveLength(4);
  expect(await fs.driver.exists('/.nestos/cloze-srs.seq')).toBe(false);
 }finally{await manager.dispose();}
});
it('does not mark a partial initialization complete and retries without overwriting existing files',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
 const original=fs.driver.createFile.bind(fs.driver);let count=0;
 const create=vi.spyOn(fs.driver,'createFile').mockImplementation(async options=>{if(++count===2)throw Object.assign(new Error('storage unavailable'),{code:'EIO'});return original(options);});
 try {
  await expect(seedStudyFiles(fs)).rejects.toMatchObject({code:'EIO'});
  expect(await fs.driver.exists('/.nestos/cloze/examples-v1.installed')).toBe(false);
  await fs.driver.writeContent('/anki/学习示例-背单词.md','Personal edit');create.mockRestore();
  await seedStudyFiles(fs);expect(await fs.driver.readContent('/anki/学习示例-背单词.md',{encoding:'utf-8'})).toBe('Personal edit');
  expect(await fs.driver.exists('/.nestos/cloze/examples-v1.installed')).toBe(true);
 }finally{create.mockRestore();await manager.dispose();}
});
it('ignores old JSON and retains existing example locations during startup',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
 try {
  const custom=[{id:'custom',name:'Mine',content:'My prompt'}];
  await fs.driver.createFile({parentPath:'/.nestos/cloze',name:'prompts.json',content:JSON.stringify(custom),recursive:true});
  await fs.driver.createFile({parentPath:'/.nestos/cloze',name:'examples-v1.installed',content:'1'});
  await fs.driver.createFile({parentPath:'/',name:'学习示例-背单词.md',content:'Existing note'});
  await seedStudyFiles(fs);
  expect(yaml.load(String(await fs.driver.readContent('/.nestos/cloze/prompts.yaml',{encoding:'utf-8'})))).not.toEqual(custom);
  expect(await fs.driver.readContent('/学习示例-背单词.md',{encoding:'utf-8'})).toBe('Existing note');
  expect(await fs.driver.exists('/anki/学习示例-背单词.md')).toBe(false);
  await fs.driver.writeContent('/.nestos/cloze/prompts.yaml','[]');await seedStudyFiles(fs);
  expect(await fs.driver.readContent('/.nestos/cloze/prompts.yaml',{encoding:'utf-8'})).toBe('[]');
 }finally{await manager.dispose();}
});

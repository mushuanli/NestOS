// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { Workbench } from '../src/core/Workbench';
import {registerStudyDocument, createAdapterStore} from '@itookit/mdx-adapter';
import {studyIndex} from '../../mdx-adapter/src/study-index';
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
it.each(['full', 'compact'] as const)('opens study from the %s sidebar menu and keeps only file, directory and root inline', async toolbar => {
 vi.stubGlobal('matchMedia', () => ({ matches:false, addEventListener(){}, removeEventListener(){} }));
 const { manager } = await createVFS({rootBackend:new MemoryBackend()}); const fs = await manager.openFileSystem('/');
 await fs.driver.createFile({parentPath:'/',name:'a.mind',content:'A --alpha--.'});
 await registerStudyDocument(fs, '/a.mind');
 const sidebar = document.createElement('div'), content = document.createElement('div'); document.body.append(sidebar,content);
 const workbench = new Workbench({files:{fs,cwd:'/'},sidebarContainer:sidebar,editorContainer:content,
  editorConfig:{plugins:['cloze:cloze']},uiOptions:{toolbar}});
 try {
  await workbench.start();
  const button = sidebar.querySelector<HTMLButtonElement>('[data-action="study"]'); expect(button).not.toBeNull();
  expect(button!.closest('details')).not.toBeNull();
  const refresh = sidebar.querySelector('[data-action=refresh]')!; expect(refresh.closest('details')).not.toBeNull();
  for (const id of ['create-file', 'create-directory', 'open-root']) expect(sidebar.querySelector(`[data-action="${id}"]`)!.closest('details')).toBeNull();
  const menu = sidebar.querySelector<HTMLDetailsElement>('.vfs-toolbar-overflow')!; expect(menu.open).toBe(false);
  expect(menu.querySelector('[data-action=import]')).not.toBeNull(); expect(menu.querySelector('[data-action=export]')).not.toBeNull();
  expect(button!.querySelector('svg')).not.toBeNull(); expect(button!.textContent).toContain('Anki');
  expect(button!.getAttribute('aria-label')).toBe('Anki 学习管理');
  button!.click();
  await vi.waitFor(()=>expect(content.querySelector('.mdx-study')).not.toBeNull(), {timeout:5000});
  await vi.waitFor(()=>expect([...content.querySelectorAll('button')].some(b=>b.textContent==='全部笔记')).toBe(true));
  [...content.querySelectorAll('button')].find(b=>b.textContent==='全部笔记')!.click();
  await vi.waitFor(()=>expect(content.textContent).toContain('未学 1'));
  expect(await createAdapterStore(fs, '/a.mind', 'cloze:memory').entries!('card:')).toEqual([]);
  const click = (label: string) => [...content.querySelectorAll('button')].find(button => button.textContent!.startsWith(label))!.click();
  click('开始学习'); click('显示答案');
  expect(await createAdapterStore(fs, '/a.mind', 'cloze:memory').entries!('card:')).toEqual([]);
  click('简单');
  await vi.waitFor(() => expect(content.textContent).toContain('本轮已完成'));
  expect(await fs.driver.exists('/.nestos/cloze-srs.seq')).toBe(true);
  click('返回概览');
  await vi.waitFor(() => expect(content.textContent).toContain('暂未到期 1'));
  const retainedStudy = content.querySelector('.mdx-study');
  expect(content.querySelector('[data-tab-id="@study"]')!.classList.contains('is-preview')).toBe(false);
  const filename = content.querySelector<HTMLButtonElement>('.mdx-study__file-link')!;
  expect(filename.textContent).toBe('a.mind'); filename.click();
  await vi.waitFor(() => expect(workbench.getActiveFilePath()).toBe('/a.mind'));
  expect(content.querySelector('.mdx-cloze')).not.toBeNull();
  expect(retainedStudy?.closest<HTMLElement>('.workbench-tabs__panel')!.hidden).toBe(true);
  const keys:string[]=[];
  await fs.meta.seq!.walkEntries('/.nestos/cloze-srs.seq', entry => {keys.push(entry.key);return true;});
  await fs.meta.seq!.deleteEntry('/.nestos/cloze-srs.seq', keys.find(key => key.includes('#card:'))!);
  await studyIndex(fs).reconcile();
  await workbench.openFile('@study');
  expect(content.querySelector('.mdx-study')).toBe(retainedStudy);
  expect(content.querySelector('[data-entry-id="/a.mind"]')!.textContent).toContain('未学 1');
 } finally {await workbench.destroy();await manager.dispose();}
});
it('creates Anki notes from the top and a directory without replacing the manager or allocating SRS records',async()=>{
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
 const modal=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal'),close=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close');
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(){this.open=false;}});
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
 await fs.driver.createFile({parentPath:'/folder',name:'source.mind',content:'--source--',recursive:true});
 await registerStudyDocument(fs, '/folder/source.mind');
 const sidebar=document.createElement('div'),content=document.createElement('div');document.body.append(sidebar,content);
 const switchToMode=vi.fn(async()=>{}),factory=vi.fn(async()=>({destroy:async()=>{},on:()=>()=>{},flushPendingSave:async()=>{},switchToMode,focus(){}}));
 const workbench=new Workbench({files:{fs,cwd:'/'},sidebarContainer:sidebar,editorContainer:content,editorFactory:factory as never,
  editorConfig:{plugins:['cloze:cloze']},uiOptions:{defaultExtension:'.mind'}});
 const submit=async(name:string,body:string)=>{
  const dialog=document.querySelector('dialog')!;dialog.querySelector<HTMLInputElement>('input[required]')!.value=name;
  dialog.querySelector<HTMLTextAreaElement>('.mdx-study-create__draft textarea')!.value=body;
  dialog.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  await vi.waitFor(()=>expect(dialog.querySelector('.mdx-study__status')?.textContent).toContain('已保存：'));
  [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='关闭')!.click();
  await vi.waitFor(()=>expect(document.querySelector('dialog')).toBeNull());
 };
 try{
  await workbench.start();await workbench.openFile('@study');
  await vi.waitFor(()=>expect(content.querySelector('[data-entry-id="/folder"]')).not.toBeNull());
  const study=content.querySelector('.mdx-study');
  [...content.querySelectorAll('button')].find(b=>b.textContent==='新增 Anki 文件')!.click();await submit('new','--new--');
  expect(await fs.driver.exists('/new.mind')).toBe(true);expect(workbench.getActiveFilePath()).toBe('@study');
  expect(switchToMode).not.toHaveBeenCalled();expect(content.querySelector('.mdx-study')).toBe(study);
  await workbench.openFile('@study');
  content.querySelector<HTMLButtonElement>('[aria-label="在此新建: folder"]')!.click();
  const dialog=document.querySelector('dialog')!;
  dialog.querySelector<HTMLInputElement>('input[required]')!.value='source';dialog.querySelector<HTMLTextAreaElement>('.mdx-study-create__draft textarea')!.value='must not overwrite';
  dialog.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  await vi.waitFor(()=>expect(dialog.querySelector('.mdx-study__status')!.textContent).toContain('EEXIST'));
  await submit('another','--another--');
  expect(await fs.driver.readContent('/folder/another.mind',{encoding:'utf-8'})).toBe('--another--');
  expect(await fs.driver.readContent('/folder/source.mind',{encoding:'utf-8'})).toBe('--source--');
  expect(await createAdapterStore(fs, '/folder/source.mind', 'cloze:memory').entries!('card:')).toEqual([]);
 }finally{
  await workbench.destroy();await manager.dispose();
  if(modal)Object.defineProperty(HTMLDialogElement.prototype,'showModal',modal);else delete (HTMLDialogElement.prototype as any).showModal;
  if(close)Object.defineProperty(HTMLDialogElement.prototype,'close',close);else delete (HTMLDialogElement.prototype as any).close;
 }
});

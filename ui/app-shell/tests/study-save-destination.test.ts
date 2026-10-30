// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@itookit/vfs-core';
import {Workbench} from '../src/core/Workbench';
const modal=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal'),close=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close');
afterEach(()=>{vi.unstubAllGlobals();document.body.replaceChildren();
 for(const [key,value] of [['showModal',modal],['close',close]] as const){if(value)Object.defineProperty(HTMLDialogElement.prototype,key,value);else delete (HTMLDialogElement.prototype as any)[key];}
});
it.each([{name:'new-note',file:'new-note.mind'},{name:'custom.md',file:'custom.md'},{name:'existing.mind',file:'existing.mind'}])('suggests untracked folders and saves $name as $file',async({name,file})=>{
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(){this.open=false;}});
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
 await fs.driver.createDirectory({parentPath:'/',name:'English'});await fs.driver.createDirectory({parentPath:'/English',name:'Reading'});
 const sidebar=document.createElement('div'),content=document.createElement('div');document.body.append(sidebar,content);
 const workbench=new Workbench({files:{fs,cwd:'/'},sidebarContainer:sidebar,editorContainer:content,editorConfig:{plugins:['cloze:cloze']},uiOptions:{defaultExtension:'.mind'}});
 try{
  await workbench.start();await workbench.openFile('@study');
  await vi.waitFor(()=>expect(content.querySelector('.mdx-study[aria-busy="false"]')).not.toBeNull());
  [...content.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='新增 Anki 文件')!.click();
  const directory=document.querySelector<HTMLInputElement>('.mdx-study-destination input')!;directory.focus();
  await vi.waitFor(()=>expect([...document.querySelectorAll('.mdx-study-destination [role=option]')].some(option=>option.textContent==='English / Reading')).toBe(true));
  directory.value='English/Reading';directory.dispatchEvent(new Event('input',{bubbles:true}));
  expect(document.querySelectorAll('.mdx-study-destination [role=option]')).toHaveLength(1);
  directory.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  expect(directory.value).toBe('English / Reading');
  document.querySelector<HTMLInputElement>('dialog input[required]')!.value=name;
  document.querySelector<HTMLTextAreaElement>('.mdx-study-create__draft textarea')!.value='--answer--';
  document.querySelector('dialog form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  await vi.waitFor(()=>expect(document.querySelector('dialog .mdx-study__status')?.textContent).toBe('已保存：/English/Reading/'+file));
  expect(document.querySelector('dialog')).not.toBeNull();expect(document.querySelector<HTMLInputElement>('dialog input[required]')!.value).toBe('');
  expect(document.querySelector<HTMLTextAreaElement>('.mdx-study-create__draft textarea')!.value).toBe('');
  expect(await fs.driver.readContent('/English/Reading/'+file,{encoding:'utf-8'})).toBe('--answer--');
  expect(await fs.driver.exists('/'+file)).toBe(false);expect(await fs.driver.exists('/English/Reading/'+file+'.mind')).toBe(false);
  expect(await fs.driver.exists('/.nestos/cloze-srs.seq')).toBe(false);
 }finally{await workbench.destroy();await manager.dispose();}
});

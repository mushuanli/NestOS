// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {StudyView} from '@itookit/mdxeditor';
import type {ApplicationBackend} from '@itookit/app-contracts/services';
import {studyGeneration} from '../src/browser/study-generation';
const modal=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal'),close=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close');
afterEach(()=>{vi.restoreAllMocks();document.body.replaceChildren();for(const [key,value] of [['showModal',modal],['close',close]] as const){if(value)Object.defineProperty(HTMLDialogElement.prototype,key,value);else delete (HTMLDialogElement.prototype as any)[key];}});
it('fills the Anki creation draft with the recovered Session body and leaves saving explicit',async()=>{
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(){this.open=false;}});
 const generateText=vi.fn(async()=>{throw new TypeError('Failed to fetch');}),save=vi.fn(async()=>{});
 const sessionResponse=vi.fn(async()=>({roundId:'round',operationId:'op',status:'completed',text:'--body only--',finishReason:'stop',thinking:'must never enter draft'}));
 const backend={createSessionDraft:async()=> 'draft',generateText,cancelTextGeneration:async()=>{},sessionResponse,
  listTextModels:async()=>[{id:'connection',name:'Connection',model:'model',models:[{id:'model',name:'Model'}],available:true,default:true}]} as unknown as ApplicationBackend;
 const view=new StudyView(document.body,{list:async()=>[],read:async()=>({content:'',revision:'1'}),store:()=>({get:async()=>undefined,set:async()=>{},remove:async()=>{}}),open:async()=>{},
  creation:{...studyGeneration(backend,{updateManifest:async()=>{}}),defaultPrompt:'Create cloze',save}});
 try{
  await view.flush();[...document.querySelectorAll('button')].find(button=>button.textContent==='新增笔记')!.click();
  const source=document.querySelector<HTMLTextAreaElement>('.mdx-study-create__source textarea')!;source.value='Source';source.dispatchEvent(new Event('input',{bubbles:true}));
  const generate=[...document.querySelectorAll('button')].find(button=>button.textContent==='生成草稿')!;
  await vi.waitFor(()=>expect(generate.disabled).toBe(false));generate.click();
  await vi.waitFor(()=>expect(document.querySelector<HTMLTextAreaElement>('.mdx-study-create__draft textarea')!.value).toBe('--body only--'));
  expect(generateText).toHaveBeenCalledOnce();expect(save).not.toHaveBeenCalled();
  expect(document.querySelector('.mdx-study__status')?.textContent).not.toContain('STUDY_FAILED');
 }finally{await view.destroy();}
});

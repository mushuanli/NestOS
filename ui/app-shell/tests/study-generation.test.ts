import {expect,it,vi} from 'vitest';
import {studyGeneration} from '../src/browser/study-generation';
import type {ApplicationBackend} from '@itookit/app-contracts/services';
it('creates a named draft session, links it before completion, reuses its identity and renames after save',async()=>{
 const createSessionDraft=vi.fn(async()=> 'draft'),generateText=vi.fn(async()=> '--draft--'),cancelTextGeneration=vi.fn(async()=>{}),updateManifest=vi.fn(async()=>{});
 const api=studyGeneration({createSessionDraft,generateText,cancelTextGeneration} as unknown as ApplicationBackend,{updateManifest});
 const onExecution=vi.fn(),request={draftId:'draft',title:'',promptName:'背概念',operationId:'first',prompt:'Convert',source:'Source',previousDraft:'',signal:new AbortController().signal,onExecution};
 await api.generate!(request);await api.generate!({...request,operationId:'second',previousDraft:'Old'});
 expect(createSessionDraft).toHaveBeenCalledWith({sessionId:'draft',title:'Anki 创建：背概念',inputText:''});
 expect(generateText.mock.calls.map(([request])=>request.sessionId)).toEqual(['draft','draft']);
 expect(onExecution).toHaveBeenCalledWith(expect.objectContaining({url:'#/chat/draft%3Fbranch%3Dmain'}));
 expect(onExecution.mock.invocationCallOrder[0]).toBeLessThan(generateText.mock.invocationCallOrder[0]);
 await api.generationSaved!({operationId:'draft',title:'Final.md',content:'--answer--'});
 expect(updateManifest).toHaveBeenCalledWith('draft',{title:'Anki 创建：Final.md'});
 await api.generationSaved!({operationId:'manual',title:'Manual.md',content:'--answer--'});expect(updateManifest).toHaveBeenCalledTimes(1);
});
it('propagates cancellation through an explicit backend operation',async()=>{
 const controller=new AbortController(),cancelTextGeneration=vi.fn(async()=>{});
 let finish!:(content:string)=>void;
 const generateText=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
 const api=studyGeneration({createSessionDraft:async()=> 'draft',generateText,cancelTextGeneration} as unknown as ApplicationBackend,{updateManifest:async()=>{}});
 const pending=api.generate!({draftId:'draft',title:'New',operationId:'op',prompt:'Convert',source:'Source',previousDraft:'',signal:controller.signal});
 await vi.waitFor(()=>expect(generateText).toHaveBeenCalledOnce());controller.abort();finish('--late--');
 await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(cancelTextGeneration).toHaveBeenCalledWith('op');
});
it('keeps nonempty limited output and explains the limit through the execution link', async () => {
 const api=studyGeneration({createSessionDraft:async()=> 'draft',generateText:async()=> 'Partial',cancelTextGeneration:async()=>{},sessionResponse:async()=>({roundId:'round',operationId:'op',status:'completed',text:'Partial',finishReason:'length'})} as unknown as ApplicationBackend,
  {updateManifest:async()=>{}});
 const onExecution=vi.fn();
 expect(await api.generate!({draftId:'draft',title:'New',operationId:'op',prompt:'Convert',source:'Source',previousDraft:'',signal:new AbortController().signal,onExecution})).toBe('Partial');
 expect(onExecution).toHaveBeenLastCalledWith(expect.objectContaining({label:'输出达到模型上限，已保留草稿，请检查结尾'}));
});
it('recovers the completed original round after a lost transport reply without resubmitting', async () => {
 const generateText=vi.fn(async()=>{throw new TypeError('Failed to fetch');});
 const sessionResponse=vi.fn(async()=>({roundId:'round',operationId:'op',status:'completed',text:'--retained--',finishReason:'stop'}));
 const api=studyGeneration({createSessionDraft:async()=> 'draft',generateText,cancelTextGeneration:async()=>{},sessionResponse} as unknown as ApplicationBackend,{updateManifest:async()=>{}});
 expect(await api.generate!({draftId:'draft',title:'New',operationId:'op',prompt:'Convert',source:'Source',previousDraft:'',signal:new AbortController().signal})).toBe('--retained--');
 expect(generateText).toHaveBeenCalledOnce();
});
it('retains explicit generation failures instead of treating them as lost replies', async () => {
 const sessionResponse=vi.fn();
 const api=studyGeneration({createSessionDraft:async()=> 'draft',generateText:async()=>{throw Object.assign(new Error('Rejected'),{code:'TEXT_AUTH_REJECTED'});},cancelTextGeneration:async()=>{},sessionResponse} as unknown as ApplicationBackend,{updateManifest:async()=>{}});
 await expect(api.generate!({draftId:'draft',title:'New',operationId:'op',prompt:'Convert',source:'Source',previousDraft:'',signal:new AbortController().signal})).rejects.toMatchObject({code:'TEXT_AUTH_REJECTED'});
 expect(sessionResponse).not.toHaveBeenCalled();
});

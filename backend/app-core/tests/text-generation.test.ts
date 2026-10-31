import {SessionCommand, type SessionInstructionQueue} from '@itookit/llm-session/contracts';
import {afterEach, expect, it, vi} from 'vitest';
import {textRuntime, response} from './helpers/text-runtime';
const cleanup: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();});
async function fixture(){const f=await textRuntime();cleanup.push(f.close);return f;}
it('uses ordinary Session output settings instead of imposing a generation-specific token cap', async () => {
 const {view,input,fetch}=await fixture();
 fetch.mockImplementation(async (_url,options)=>JSON.parse(options.body).max_tokens===undefined?response('--complete--'):response('','length'));
 expect(await view.backend.generateText(input)).toBe('--complete--');
 expect(JSON.parse(fetch.mock.calls[0][1].body).max_tokens).toBeUndefined();expect(fetch).toHaveBeenCalledOnce();
},20000);
it('persists repeat generations as rounds in the personal project with the selected model',async()=>{
 const {runtime,view,input,fetch}=await fixture();
 const other=await runtime.projects.create('Other default');await runtime.projects.setDefaultProject(other.project.id);
 input.sessionId=await view.backend.createSessionDraft({title:'Generated in Personal',inputText:''});
 expect(await view.backend.generateText({...input,connectionId:'default',modelId:'alternate'})).toBe('--generated--');
 expect(await view.backend.generateText({...input,operationId:'second',previousDraft:'Old draft'})).toBe('--generated--');
 const rounds=(await runtime.sessionRepository.readHistoryChain(input.sessionId)).rounds;
 expect(rounds).toHaveLength(2);expect(rounds.every(round=>round.status==='completed')).toBe(true);
 expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe('alternate');
 expect(JSON.stringify(rounds[0].input)).toContain(input.prompt);
 expect(JSON.stringify(JSON.parse(fetch.mock.calls[0][1].body).messages)).toContain(input.prompt);
 expect(JSON.stringify(rounds[1].input)).toContain('Old draft');
 const personal=await runtime.projects.personal();expect((await runtime.sessionRepository.getManifest(input.sessionId)).folder).toBe(await runtime.projects.sessionFolder(personal));
},20000);
it('rejects invalid models without provider calls and reports empty or truncated output',async()=>{
 const {view,input,fetch}=await fixture();
 await expect(view.backend.generateText({...input,modelId:'missing'})).rejects.toMatchObject({code:'TEXT_MODEL_UNAVAILABLE'});expect(fetch).not.toHaveBeenCalled();
 fetch.mockResolvedValueOnce(response('','stop'));await expect(view.backend.generateText(input)).rejects.toMatchObject({code:'TEXT_OUTPUT_EMPTY'});
 fetch.mockResolvedValueOnce(response('Partial','length'));expect(await view.backend.generateText({...input,operationId:'truncated'})).toBe('Partial');
 fetch.mockResolvedValueOnce(response('','length'));await expect(view.backend.generateText({...input,operationId:'empty-truncated'})).rejects.toMatchObject({code:'TEXT_OUTPUT_EMPTY'});
},20000);
it('cancels only the generated task and retains its session history',async()=>{
 const {runtime,view,input,fetch}=await fixture();
 fetch.mockImplementationOnce(async (_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))));
 const pending=view.backend.generateText(input),assertion=expect(pending).rejects.toMatchObject({code:'TEXT_CANCELLED'});
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalled(),{timeout:10000});await view.backend.cancelTextGeneration(input.operationId);await assertion;
 expect((await runtime.sessionRepository.readHistoryChain(input.sessionId)).rounds).toHaveLength(1);
 await view.backend.cancelTextGeneration('early');await expect(view.backend.generateText({...input,operationId:'early'})).rejects.toMatchObject({code:'TEXT_CANCELLED'});
},20000);
it('removes a queued generation without cancelling the active generation in the same session',async()=>{
 const {runtime,view,input,fetch}=await fixture();
 const lease=await runtime.openConversation(input.sessionId);cleanup.push(()=>lease.dispose());
 fetch.mockImplementationOnce(async (_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))));
 const first=view.backend.generateText(input),firstResult=expect(first).rejects.toMatchObject({code:'TEXT_CANCELLED'});
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce(),{timeout:10000});
 const second=view.backend.generateText({...input,operationId:'queued'}),secondResult=expect(second).rejects.toMatchObject({code:'TEXT_CANCELLED'});
 await vi.waitFor(async()=>{const queue=await lease.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);expect(queue.items.some(item=>item.id==='queued' && item.state==='pending')).toBe(true);});
 await view.backend.cancelTextGeneration('queued');await secondResult;
 expect(fetch).toHaveBeenCalledOnce();await view.backend.cancelTextGeneration('first');await firstResult;
},20000);
it('joins cancellation before releasing the application view',async()=>{
 const {view,input,fetch}=await fixture();
 fetch.mockImplementationOnce(async (_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))));
 const pending=view.backend.generateText(input),result=expect(pending).rejects.toMatchObject({code:'TEXT_CANCELLED'});
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce(),{timeout:10000});await view.close();await result;
},20000);

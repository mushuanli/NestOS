import {afterEach, expect, it, vi} from 'vitest';
import {openApplicationView} from '../src/host';
import {textRuntime} from './helpers/text-runtime';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();});
it('shows background generation thinking and content in a separately opened Session before completion',async()=>{
 const f=await textRuntime();cleanup.push(f.close);
 const reader=await openApplicationView(f.runtime);cleanup.push(()=>reader.close());
 const session=await reader.backend.openSessionView(f.input.sessionId);cleanup.push(()=>session.dispose());await session.activate('main');
 let stream!:ReadableStreamDefaultController<Uint8Array>;
 f.fetch.mockImplementationOnce(async()=>new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{'content-type':'text/event-stream'}}));
 const events:unknown[]=[];const stop=reader.services.sessionManager.onEvent(event=>events.push(event));
 const pending=f.view.backend.generateText(f.input);
 try{
  await vi.waitFor(()=>expect(stream).toBeDefined(),{timeout:10000});
  const send=(delta:unknown,finish_reason:string|null=null)=>stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'response',choices:[{index:0,delta,finish_reason}]})}\n\n`));
  send({role:'assistant',reasoning_content:'Visible thinking'});
  send({content:'Visible partial draft'});
  await vi.waitFor(()=>expect(JSON.stringify(reader.services.sessionManager.getSnapshot())).toContain('Visible partial draft'),{timeout:10000});
  expect(JSON.stringify(reader.services.sessionManager.getSnapshot())).toContain('Visible thinking');expect(events.length).toBeGreaterThan(0);
  send({},'stop');stream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));stream.close();
  expect(await pending).toBe('Visible partial draft');
  await vi.waitFor(()=>expect(reader.services.sessionManager.getSnapshot().isRunning).toBe(false));
  await vi.waitFor(()=>expect(JSON.stringify(reader.services.sessionManager.getSnapshot())).toContain('Visible partial draft'));
 }finally{stop();await f.view.backend.cancelTextGeneration(f.input.operationId);await pending.catch(()=>{});}
},20000);
it('isolates observed sessions and releases both subscriptions when the reader closes',async()=>{
 const {observeConversation}=await import('../src/host/conversation-observation');
 let remote!:(id:string,event:any,snapshot:any)=>void;let local!:(event:any)=>void;
 const localStop=vi.fn(),remoteStop=vi.fn(),snapshot={sessionId:'one',isRunning:false,view:{manifest:{currentBranch:'main'}}};
 const manager={getSnapshot:()=>snapshot,onGlobalEvent:vi.fn(),onEvent:(listener:any)=>{local=listener;return localStop;}};
 const observed=observeConversation(manager as never,{subscribe:listener=>{remote=listener;return remoteStop;}}),listener=vi.fn();
 const stop=observed.onEvent(listener);
 remote('two',{type:'message:updated'},{...snapshot,sessionId:'two',isRunning:true});expect(listener).not.toHaveBeenCalled();
 remote('one',{type:'message:updated'},{...snapshot,isRunning:true,view:{manifest:{currentBranch:'other'}}});expect(listener).not.toHaveBeenCalled();
 remote('one',{type:'message:updated'},{...snapshot,isRunning:true});expect(observed.getSnapshot().isRunning).toBe(true);
 local({type:'session:bound'});expect(observed.getSnapshot().isRunning).toBe(false);
 stop();expect(localStop).toHaveBeenCalledOnce();expect(remoteStop).toHaveBeenCalledOnce();
});

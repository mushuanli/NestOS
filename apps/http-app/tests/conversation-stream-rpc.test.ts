import {expect,it,vi} from 'vitest';
import {RpcPeer,installViewProjections} from '@itookit/app-transport/application';
import {openApplicationView} from '@itookit/app-core/host';
import {textRuntime} from '../../../backend/app-core/tests/helpers/text-runtime';
it('transports background thinking and content to an already open Session reader',async()=>{
 const f=await textRuntime(),reader=await openApplicationView(f.runtime);let server!:RpcPeer;
 const client=new RpcPeer('client',call=>server.handle(call),console.error,installViewProjections);
 server=new RpcPeer('server',async call=>{client.applyUpdates(await server.refresh());return client.handle(call);},console.error);
 let stop=()=>{},pending:Promise<string>|undefined;
 try{
  const boot=await server.bootstrap(reader);client.applyUpdates(boot.updates);const remote=client.decode(boot.value!);
  const lease=await remote.backend.openSessionView(f.input.sessionId);await lease.activate('main');
  const events:unknown[]=[];stop=await remote.services.sessionManager.onEvent((event:unknown)=>events.push(event));
  let stream!:ReadableStreamDefaultController<Uint8Array>;
  f.fetch.mockImplementationOnce(async()=>new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{'content-type':'text/event-stream'}}));
  pending=f.view.backend.generateText(f.input);
  await vi.waitFor(()=>expect(stream).toBeDefined(),{timeout:10000});
  const send=(delta:unknown,finish_reason:string|null=null)=>stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:'response',choices:[{index:0,delta,finish_reason}]})}\n\n`));
  send({role:'assistant',reasoning_content:'RPC thinking'});send({content:'RPC partial output'});
  await vi.waitFor(()=>expect(JSON.stringify(remote.services.sessionManager.getSnapshot())).toContain('RPC partial output'),{timeout:10000});
  expect(JSON.stringify(remote.services.sessionManager.getSnapshot())).toContain('RPC thinking');expect(events.length).toBeGreaterThan(0);
  send({},'stop');stream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));stream.close();expect(await pending).toBe('RPC partial output');
  expect(await remote.backend.sessionResponse(f.input.sessionId,{operationId:f.input.operationId,branch:'main'})).toMatchObject({status:'completed',text:'RPC partial output'});
  await lease.dispose();
 }finally{stop();await f.view.backend.cancelTextGeneration(f.input.operationId);await pending?.catch(()=>{});await client.close();await server.close();await reader.close();await f.close();vi.restoreAllMocks();}
},20000);

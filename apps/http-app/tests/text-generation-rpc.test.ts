import {expect, it} from 'vitest';
import {RpcPeer, installViewProjections} from '@itookit/app-transport/application';
import {textRuntime} from '../../../backend/app-core/tests/helpers/text-runtime';
it('creates durable generation history through actual application RPC',async()=>{
 const f=await textRuntime();let server!:RpcPeer;
 const client=new RpcPeer('client',call=>server.handle(call),console.error,installViewProjections);
 server=new RpcPeer('server',async call=>{client.applyUpdates(await server.refresh());return client.handle(call);},console.error);
 try {
  const boot=await server.bootstrap(f.view.backend);client.applyUpdates(boot.updates);const remote=client.decode(boot.value!);
  expect(await remote.listTextModels()).toEqual(expect.arrayContaining([expect.objectContaining({id:'default',available:true})]));
  expect((await remote.studyPromptPresets()).map((item:any)=>item.id)).toEqual(['vocabulary','concepts','classical-chinese']);
  expect(await remote.generateText({...f.input,connectionId:'default',modelId:'alternate'})).toBe('--generated--');
  expect((await f.runtime.sessionRepository.readHistoryChain(f.input.sessionId)).rounds[0].status).toBe('completed');
  await remote.cancelTextGeneration('early');
  await expect(remote.generateText({...f.input,operationId:'early'})).rejects.toMatchObject({code:'TEXT_CANCELLED'});
 }finally{await client.close();await server.close();await f.close();}
},20000);

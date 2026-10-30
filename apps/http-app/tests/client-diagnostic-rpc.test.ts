import {afterEach,expect,it,vi} from 'vitest';
import {RpcPeer,installViewProjections} from '@itookit/app-transport/application';
import {textRuntime} from '../../../backend/app-core/tests/helpers/text-runtime';
afterEach(()=>vi.restoreAllMocks());
it('receives client diagnostic metadata through RPC and rejects content fields',async()=>{
 const f=await textRuntime();let server!:RpcPeer;const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const client=new RpcPeer('client',call=>server.handle(call),console.error,installViewProjections);
 server=new RpcPeer('server',async call=>{client.applyUpdates(await server.refresh());return client.handle(call);},console.error);
 try{
  const boot=await server.bootstrap(f.view.backend);client.applyUpdates(boot.updates);const remote=client.decode(boot.value!);
  const value={operation:'text.result',operationId:'op',sessionId:f.input.sessionId,stage:'query-wait',code:'TEXT_RESULT_QUERY_TIMEOUT',result:'retrying',durationMs:10000};
  await remote.reportClientDiagnostic(value);
  expect(warn).toHaveBeenCalledWith('[ClientDiagnostic]',expect.objectContaining({...value,source:'client'}));warn.mockClear();
  await expect(remote.reportClientDiagnostic({...value,prompt:'private prompt'})).rejects.toMatchObject({code:'CLIENT_DIAGNOSTIC_INVALID'});
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private prompt');
 }finally{await client.close();await server.close();await f.close();}
},20000);

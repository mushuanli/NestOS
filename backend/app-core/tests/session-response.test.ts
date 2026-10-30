import {afterEach,expect,it,vi} from 'vitest';
import {assistantResponseText} from '@itookit/llm-session/contracts';
import {textRuntime} from './helpers/text-runtime';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();});
it('selects the latest or exact operation response and never substitutes another round',async()=>{
 const f=await textRuntime();cleanup.push(f.close);
 expect(await f.view.backend.sessionResponse(f.input.sessionId)).toBeUndefined();
 await f.view.backend.generateText(f.input);
 f.fetch.mockResolvedValueOnce(new Response('data: '+JSON.stringify({choices:[{delta:{content:'Second'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}));
 await f.view.backend.generateText({...f.input,operationId:'second'});
 const latest=await f.view.backend.sessionResponse(f.input.sessionId);
 expect(latest).toMatchObject({operationId:'second',status:'completed',text:'Second'});
 expect(await f.view.backend.sessionResponse(f.input.sessionId,{operationId:'first',branch:'main'})).toMatchObject({operationId:'first',text:'--generated--'});
 expect(await f.view.backend.sessionResponse(f.input.sessionId,{roundId:latest!.roundId})).toEqual(latest);
 expect(await f.view.backend.sessionResponse(f.input.sessionId,{operationId:'missing'})).toBeUndefined();
 expect(await f.view.backend.sessionResponse(f.input.sessionId,{branch:'missing'})).toBeUndefined();
 await expect(f.view.backend.sessionResponse(f.input.sessionId,{operationId:'first',roundId:latest!.roundId})).rejects.toMatchObject({code:'SESSION_RESPONSE_SELECTOR_INVALID'});
},20000);
it('extracts only assistant text, excluding reasoning blocks, tools, images and user messages',()=>{
 expect(assistantResponseText({output:[{role:'user',content:'private source'},{role:'tool',content:'tool result'},
  {role:'assistant',content:[{type:'thinking',thinking:'private reasoning'},{type:'text',text:'Answer'},{type:'image',url:'image'}]},
  {role:'assistant',content:'Tail'}]} as never)).toBe('Answer\nTail');
});

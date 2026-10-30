import {afterEach,expect,it,vi} from 'vitest';
import {sessionGenerationResult} from '../src/browser/session-generation-result';
import type {ApplicationBackend} from '@itookit/app-contracts/services';
afterEach(()=>vi.useRealTimers());
const request={sessionId:'session',operationId:'op',prompt:'Prompt',source:'Source',previousDraft:''};
it('finishes from the durable result while the original generation reply remains pending',async()=>{
 vi.useFakeTimers();let finish!:(value:string)=>void;
 const generateText=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
 const sessionResponse=vi.fn().mockResolvedValueOnce({roundId:'round',status:'running',text:''}).mockResolvedValue({roundId:'round',status:'completed',text:'--durable--'});
 const result=sessionGenerationResult({generateText,sessionResponse} as unknown as ApplicationBackend,request,new AbortController().signal,vi.fn());
 await vi.advanceTimersByTimeAsync(1000);expect(await result).toBe('--durable--');expect(generateText).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);finish('--late reply--');
});
it('does not keep the UI busy while an optional metadata query remains pending',async()=>{
 const generateText=vi.fn(async()=> '--complete--'),sessionResponse=vi.fn(()=>new Promise(()=>{}));
 expect(await sessionGenerationResult({generateText,sessionResponse} as unknown as ApplicationBackend,request,new AbortController().signal,vi.fn())).toBe('--complete--');
});
it('does not report a late lost reply after the durable operation already completed',async()=>{
 let reject!:(error:Error)=>void;const disconnected=vi.fn();
 const generateText=()=>new Promise<string>((_resolve,fail)=>{reject=fail;}),sessionResponse=async()=>({roundId:'r',status:'completed',text:'Done'});
 expect(await sessionGenerationResult({generateText,sessionResponse} as unknown as ApplicationBackend,request,new AbortController().signal,disconnected)).toBe('Done');
 reject(new TypeError('Failed to fetch'));await Promise.resolve();expect(disconnected).not.toHaveBeenCalled();
});
it('does not turn a slow auxiliary query into generation failure while the original request is still running',async()=>{
 vi.useFakeTimers();
 const generateText=vi.fn(()=>new Promise<string>(resolve=>setTimeout(()=>resolve('--completed later--'),37000)));
 const sessionResponse=vi.fn(()=>new Promise(()=>{})),reportClientDiagnostic=vi.fn(async()=>{}),disconnected=vi.fn();
 const result=sessionGenerationResult({generateText,sessionResponse,reportClientDiagnostic} as unknown as ApplicationBackend,request,new AbortController().signal,disconnected);
 let settled=false;void result.then(()=>{settled=true;});
 await vi.advanceTimersByTimeAsync(11000);expect(settled).toBe(false);
 expect(reportClientDiagnostic).toHaveBeenCalledWith(expect.objectContaining({operationId:'op',stage:'query-wait',code:'TEXT_RESULT_QUERY_TIMEOUT',result:'retrying',durationMs:10000}));
 await vi.advanceTimersByTimeAsync(26000);expect(await result).toBe('--completed later--');
 expect(generateText).toHaveBeenCalledOnce();expect(sessionResponse).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('retries transient query rejection and accepts the terminal durable result',async()=>{
 vi.useFakeTimers();
 const generateText=vi.fn(()=>new Promise(()=>{})),sessionResponse=vi.fn().mockRejectedValueOnce(new TypeError('private response body'))
  .mockResolvedValue({roundId:'r',status:'completed',text:'--recovered--'}),reportClientDiagnostic=vi.fn(async()=>{});
 const result=sessionGenerationResult({generateText,sessionResponse,reportClientDiagnostic} as unknown as ApplicationBackend,request,new AbortController().signal,vi.fn());
 await vi.advanceTimersByTimeAsync(1000);expect(await result).toBe('--recovered--');
 expect(JSON.stringify(reportClientDiagnostic.mock.calls)).not.toContain('private response body');
 expect(reportClientDiagnostic).toHaveBeenCalledWith(expect.objectContaining({code:'TEXT_RESULT_QUERY_TRANSPORT_FAILED',result:'retrying'}));
});
it('preserves the server rejection category and request ID when both response paths fail',async()=>{
 const requestId='12345678-1234-1234-1234-123456789012',reportClientDiagnostic=vi.fn(async()=>{});
 const generateText=vi.fn(async()=>{throw new TypeError('private original body');});
 const sessionResponse=vi.fn(async()=>{throw Object.assign(new Error('private database body'),{code:'EIO',remoteCode:'SQLITE_BUSY',requestId});});
 await expect(sessionGenerationResult({generateText,sessionResponse,reportClientDiagnostic} as unknown as ApplicationBackend,request,new AbortController().signal,vi.fn())).rejects.toMatchObject({code:'TEXT_RESULT_QUERY_REJECTED',remoteCode:'SQLITE_BUSY',requestId});
 expect(reportClientDiagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:'query-request',result:'failure',remoteCode:'SQLITE_BUSY',requestId}));
 expect(JSON.stringify(reportClientDiagnostic.mock.calls)).not.toContain('private');expect(generateText).toHaveBeenCalledOnce();
});

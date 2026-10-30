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

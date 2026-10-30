import {afterEach,expect,it,vi} from 'vitest';
import {recoverGenerationResult} from '../src/browser/generation-result-recovery';
afterEach(()=>vi.useRealTimers());
it('waits for the same running round to finish without consuming a different operation',async()=>{
 vi.useFakeTimers();
 const sessionResponse=vi.fn().mockResolvedValueOnce({roundId:'r',operationId:'op',status:'running',text:''}).mockResolvedValue({roundId:'r',operationId:'op',status:'completed',text:'right'});
 const result=recoverGenerationResult({sessionResponse},'session','op',new AbortController().signal);
 await vi.advanceTimersByTimeAsync(1000);expect(await result).toBe('right');expect(sessionResponse).toHaveBeenCalledTimes(2);expect(sessionResponse).toHaveBeenCalledWith('session',{operationId:'op',branch:'main'});
});
it('stops waiting on cancellation',async()=>{
 vi.useFakeTimers();const controller=new AbortController();
 const sessionResponse=vi.fn(async()=>({roundId:'r',operationId:'op',status:'running',text:''} as never));
 const result=recoverGenerationResult({sessionResponse},'session','op',controller.signal);
 const assertion=expect(result).rejects.toMatchObject({name:'AbortError'});
 await vi.advanceTimersByTimeAsync(1);controller.abort();await assertion;expect(vi.getTimerCount()).toBe(0);
});
it('reports an unconfirmed submission after a bounded lookup instead of resubmitting',async()=>{
 vi.useFakeTimers();const sessionResponse=vi.fn(async()=>undefined);
 const result=recoverGenerationResult({sessionResponse},'session','op',new AbortController().signal);
 const assertion=expect(result).rejects.toMatchObject({code:'TEXT_RESULT_UNCONFIRMED'});
 await vi.advanceTimersByTimeAsync(30000);await assertion;
});

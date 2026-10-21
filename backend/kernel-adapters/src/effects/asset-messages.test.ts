import {expect, it, vi} from 'vitest';
import {materializeAssetMessages} from './asset-messages';
import type {ChatCompletionParams} from '@itookit/driver-llm/contracts';
import type {EffectExecutionContext} from '@itookit/durable-kernel';
const asset={sessionId:'s',taskId:'source',owner:'tasks/source',name:'hash.bin',mimeType:'image/png',bytes:3,sha256:'hash'};
const request=()=>({model:'vision',messages:[{role:'user',content:[{type:'image',source:{type:'asset',asset}}]}]}) as unknown as ChatCompletionParams;
const context={sessionId:'s',taskId:'consumer',effectId:'llm',abortSignal:new AbortController().signal} as EffectExecutionContext;
it('materializes at dispatch without changing durable requests and binds the consumer identity',async()=>{
    const read=vi.fn(async()=>new Uint8Array([1,2,3])), original=request();
    expect(await materializeAssetMessages(original,context,read)).toMatchObject({messages:[{content:[{type:'image_url',image_url:{url:'data:image/png;base64,AQID'}}]}]});
    expect(original).toEqual(request());
    expect(read).toHaveBeenCalledWith(asset,expect.objectContaining({sessionId:'s',taskId:'consumer',operationId:'llm'}));
    await expect(materializeAssetMessages(original,context)).rejects.toThrow('unavailable');
    read.mockRejectedValueOnce(new Error('another Flow'));
    await expect(materializeAssetMessages(original,context,read)).rejects.toThrow('another Flow');
});
it('rejects unsupported media and oversized requests before reading bytes',async()=>{
    const read=vi.fn(async()=>new Uint8Array([1]));
    const oversized=request();(oversized.messages[0].content as unknown as {source:{asset:typeof asset}}[])[0].source.asset={...asset,bytes:33*1024*1024};
    await expect(materializeAssetMessages(oversized,context,read)).rejects.toThrow('budget');
    expect(read).not.toHaveBeenCalled();
});

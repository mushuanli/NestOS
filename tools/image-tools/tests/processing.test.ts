import {expect, it, vi} from 'vitest';
import sharp from 'sharp';
import {createTools, sharpEngine} from '../src/node';
import {createImageTools} from '../src/core';
import {imageInputSchema} from '../src/contract';
import type {ToolUseContext} from '@itookit/tools';
import {sha256Hex} from '@itookit/llm-context';
const recipe = {version:1 as const, resize:{mode:'max-edge' as const,maxEdge:100},color:'grayscale' as const,
    output:{mimeType:'image/jpeg' as const,quality:0.9,minQuality:0.65,maxBytes:5000}};
const fixture = () => sharp({create:{width:200,height:100,channels:3,background:'#e03070'}}).png().toBuffer();

it('resizes without upscaling, converts real pixels and enforces byte and decode budgets', async () => {
    const data = await fixture(), result = await sharpEngine.process(data,recipe,new AbortController().signal);
    expect(result).toMatchObject({mimeType:'image/jpeg',width:100,height:50});
    const pixels = await sharp(result.data).raw().toBuffer();
    expect(pixels[0]).toBe(pixels[1]); expect(pixels[1]).toBe(pixels[2]);
    expect(result.data.length).toBeLessThanOrEqual(5000);
    await expect(sharpEngine.process(data,{...recipe,output:{...recipe.output,maxBytes:1}},new AbortController().signal)).rejects.toThrow('byte budget');
    const small = await sharp({create:{width:10,height:5,channels:3,background:'white'}}).png().toBuffer();
    expect(await sharpEngine.process(small,recipe,new AbortController().signal)).toMatchObject({width:10,height:5});
    await expect(sharpEngine.process(new Uint8Array([1,2]),recipe,new AbortController().signal)).rejects.toThrow();
    const controller = new AbortController();controller.abort();
    await expect(sharpEngine.process(data,recipe,controller.signal)).rejects.toThrow();
});

it('preserves originals, retries only failed images, verifies cached assets and changes cache keys with recipes', async () => {
    const assets = new Map<string,Uint8Array>(), records = new Map<string,unknown>();
    const context = {cwd:'/',timeoutMs:30000,operationId:'op',signal:new AbortController().signal,
        async writeAsset(data:Uint8Array,mimeType:string) {const sha256=await sha256Hex(data);assets.set(sha256,data);return {sessionId:'s',taskId:'t',owner:'tasks/t',name:`${sha256}.bin`,mimeType,bytes:data.length,sha256};},
        async readAsset(ref:{sha256:string}) {const data=assets.get(ref.sha256);if(!data||await sha256Hex(data)!==ref.sha256)throw new Error('corrupt');return data;},
        async getAssetRecord(key:string) {return records.get(key);},async putAssetRecord(key:string,value:unknown) {records.set(key,value);},
    } as ToolUseContext;
    const second = await sharp({create:{width:10,height:10,channels:3,background:'blue'}}).png().toBuffer();
    const images = await Promise.all([fixture(),second].map(async value=>({type:'image_url',image_url:{url:`data:image/png;base64,${Buffer.from(await value).toString('base64')}`}})));
    let calls=0, fail=true;
    const process=vi.fn(async (...args:Parameters<typeof sharpEngine.process>)=>{calls++;if(calls===2&&fail)throw new Error('transient');return sharpEngine.process(...args);});
    const [tool]=createImageTools({...sharpEngine,process}), args=imageInputSchema.parse({images,recipe});
    await expect(tool.call(args,context)).rejects.toThrow('transient');
    expect(records.size).toBe(1);fail=false;
    const {data:result}=await tool.call(args,context);expect(calls).toBe(3);expect(result.images).toHaveLength(2);
    expect(result.items[0].source.sha256).not.toBe(result.items[0].output.sha256);
    expect(await tool.reconcile!(args,context)).toMatchObject({status:'completed'});expect(calls).toBe(3);
    await tool.call({...args,recipe:{...recipe,color:'threshold',threshold:90}},context);expect(calls).toBe(5);
    assets.set(result.items[0].output.sha256,new Uint8Array([7]));
    await expect(tool.call(args,context)).rejects.toThrow('corrupt');
    expect(createTools()[0].name).toBe('image.process');
});

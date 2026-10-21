import {buildTool, type ToolUseContext} from '@itookit/tools';
import type {BinaryAssetReference, TaskAssetReference} from '@itookit/tools/contracts';
import {sha256Hex} from '@itookit/llm-context';
import {validateImageRecipe} from '@itookit/image-parser/processing';
import {imageInputSchema, type ImageEngine, type ImageInput} from './contract';
export interface Item {source: TaskAssetReference; output: TaskAssetReference; width: number; height: number; engine: {id: string; version: string}; recipe: ImageInput['recipe']}
export interface ImagePart {type: 'image'; source: {type: 'asset'; asset: TaskAssetReference}}

export function createImageTools(engine: ImageEngine) {
    return [buildTool({name: 'image.process', version: '1', inputSchema: imageInputSchema, maxResultSizeChars: 100000,
        searchHint: 'Resize and encode image assets', isReadOnly: () => true, interruptBehavior: () => 'cancel',
        async description() {return 'Process authorized image assets with a versioned resize/color/encoding recipe. Preserve originals and report verified derived assets. No network requests.';},
        async prompt() {return this.description();},
        async call(args, context) {return {data: await processImages(args, context, engine)};},
        // Pure processing and content-addressed writes may be retried after worker loss.
        async reconcile(args, context) {return {status: 'completed', data: await processImages(imageInputSchema.parse(args), context, engine)};},
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};},
    })];
}
async function processImages(args: ImageInput, context: ToolUseContext, engine: ImageEngine) {
    if (!context.writeAsset || !context.readAsset || !context.getAssetRecord || !context.putAssetRecord || !context.operationId) throw new Error('Image processing requires durable asset ports');
    const recipe = validateImageRecipe(args.recipe), items: Item[] = [], images: ImagePart[] = [];
    let bytes = 0;
    for (const image of args.images) {
        context.signal?.throwIfAborted();
        const data = await readSource(image, context), hash = await sha256Hex(data);
        const key = `image/v1/${await sha256Hex(JSON.stringify({hash, recipe, engine: {id: engine.id, version: engine.version}}))}`;
        let item = await context.getAssetRecord(key) as Item | undefined;
        if (item) {await context.readAsset(item.source); await context.readAsset(item.output);}
        else {
            const result = await engine.process(data, recipe, context.signal ?? new AbortController().signal);
            const source = await context.writeAsset(data, sourceMime(data));
            const output = await context.writeAsset(result.data, result.mimeType);
            item = {source, output, width: result.width, height: result.height, engine: {id: engine.id, version: engine.version}, recipe};
            await context.putAssetRecord(key, item);
        }
        bytes += item.output.bytes;
        if (bytes > args.maxTotalBytes) throw new Error('Processed images exceed total byte budget');
        items.push(item); images.push({type: 'image', source: {type: 'asset', asset: item.output}});
    }
    return {images, items, bytes};
}
async function readSource(value: unknown, context: ToolUseContext): Promise<Uint8Array> {
    const part = value as {type?: string; source?: {type?: string; asset?: BinaryAssetReference}; image_url?: {url?: string}; path?: string};
    let data: Uint8Array;
    if (part?.type === 'image' && part.source?.type === 'asset' && part.source.asset) data = await context.readAsset!(part.source.asset);
    else if (typeof part?.path === 'string' && context.vfs?.readBinaryFile) data = await context.vfs.readBinaryFile(part.path, {maxBytes: 20 * 1024 * 1024});
    else {
        const url = part?.image_url?.url;
        if (typeof url !== 'string' || url.length > 28 * 1024 * 1024) throw new Error('Unsupported image source');
        const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
        if (!match || match[1].length % 4) throw new Error('Invalid inline image');
        data = Uint8Array.from(atob(match[1]), char => char.charCodeAt(0));
    }
    if (!data.length || data.length > 20 * 1024 * 1024) throw new Error('Image exceeds input byte budget');
    sourceMime(data); return data;
}
function sourceMime(data: Uint8Array): string {
    if (data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return 'image/png';
    if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
    if (new TextDecoder().decode(data.subarray(0,4)) === 'RIFF' && new TextDecoder().decode(data.subarray(8,12)) === 'WEBP') return 'image/webp';
    throw new Error('Unsupported image signature');
}

export type {ImageEngine} from './contract';

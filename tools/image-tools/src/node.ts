import sharp from 'sharp';
import {encodingQualities, validateImageRecipe, type ImageRecipe} from '@itookit/image-parser/processing';
import {createImageTools} from './core';
import type {ImageEngine} from './contract';
export const sharpEngine: ImageEngine = {id: 'sharp', version: `1/${sharp.versions.sharp}/${sharp.versions.vips}`, process: processImage};
export function createTools() {return createImageTools(sharpEngine);}
async function processImage(data: Uint8Array, input: ImageRecipe, signal: AbortSignal) {
    const recipe = validateImageRecipe(input); signal.throwIfAborted();
    const metadata = await sharp(data, {limitInputPixels: 40_000_000, failOn: 'warning'}).metadata();
    if ((metadata.pages ?? 1) !== 1 || !['png','jpeg','webp'].includes(metadata.format ?? '')) throw new Error('Unsupported or animated image');
    const ratio = recipe.resize.mode === 'original' ? 1 : Math.min(1, recipe.resize.maxEdge / Math.max(metadata.width!, metadata.height!));
    if (Math.max(metadata.width!, metadata.height!) * ratio > 8192 || metadata.width! * metadata.height! * ratio * ratio > 12_000_000) throw new Error('Image exceeds output pixel budget');
    for (const quality of encodingQualities(recipe)) {
        const pipeline = sharp(data, {limitInputPixels: 40_000_000, failOn: 'warning'}).rotate().timeout({seconds: 30});
        if (recipe.resize.mode === 'max-edge') pipeline.resize({width: recipe.resize.maxEdge, height: recipe.resize.maxEdge, fit: 'inside', withoutEnlargement: true});
        if (recipe.color !== 'preserve') pipeline.flatten({background: '#ffffff'}).greyscale();
        if (recipe.color === 'threshold') pipeline.threshold(recipe.threshold ?? 128);
        pipeline.toFormat(recipe.output.mimeType.slice(6) as 'png'|'jpeg'|'webp', {quality: Math.round(quality * 100)});
        const abort = () => {pipeline.destroy(new Error('Image processing aborted'));};
        signal.addEventListener('abort', abort, {once: true});
        try {
            signal.throwIfAborted();
            const {data: output, info} = await pipeline.toBuffer({resolveWithObject: true});
            signal.throwIfAborted();
            if (info.width * info.height > 12_000_000 || Math.max(info.width, info.height) > 8192) throw new Error('Image exceeds output pixel budget');
            if (recipe.output.maxBytes === undefined || output.length <= recipe.output.maxBytes) return {data: new Uint8Array(output), mimeType: recipe.output.mimeType, width: info.width, height: info.height};
        } finally {signal.removeEventListener('abort', abort); pipeline.destroy();}
    }
    throw new Error('Image exceeds output byte budget at minimum quality');
}

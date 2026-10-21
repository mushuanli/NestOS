import {z} from 'zod/v4';
import type {ImageRecipe} from '@itookit/image-parser/processing';
export interface ProcessedImage {data: Uint8Array; mimeType: string; width: number; height: number}
export interface ImageEngine {id: string; version: string; process(data: Uint8Array, recipe: ImageRecipe, signal: AbortSignal): Promise<ProcessedImage>}
const resize = z.discriminatedUnion('mode', [z.object({mode: z.literal('original')}).strict(), z.object({mode: z.literal('max-edge'), maxEdge: z.number().int().min(1).max(8192)}).strict()]);
export const recipeSchema = z.object({version: z.literal(1), resize, color: z.enum(['preserve','grayscale','threshold']), threshold: z.number().int().min(0).max(255).optional(),
    output: z.object({mimeType: z.enum(['image/png','image/jpeg','image/webp']), quality: z.number().min(0.1).max(1), minQuality: z.number().min(0.1).max(1).optional(), maxBytes: z.number().int().positive().optional()}).strict()}).strict();
export const imageInputSchema = z.object({images: z.array(z.unknown()).min(1).max(16), recipe: recipeSchema,
    maxTotalBytes: z.number().int().positive().max(32 * 1024 * 1024).default(24 * 1024 * 1024)}).strict();
export type ImageInput = z.infer<typeof imageInputSchema>;

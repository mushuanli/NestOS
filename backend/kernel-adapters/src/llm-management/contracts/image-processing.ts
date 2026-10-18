/** Serializable input preferences; image implementations remain host-owned. */
export type ImageResizePolicy = {readonly mode: 'original'} | {readonly mode: 'max-edge'; readonly maxEdge: number};
export interface ImageProcessingPreference {readonly resize?: ImageResizePolicy}
export function isImageResizePolicy(value: unknown): value is ImageResizePolicy {
    if (!value || typeof value !== 'object') return false;
    const p = value as {mode?: unknown; maxEdge?: unknown};
    return p.mode === 'original' || p.mode === 'max-edge' && typeof p.maxEdge === 'number'
        && Number.isInteger(p.maxEdge) && p.maxEdge >= 1 && p.maxEdge <= 32768;
}

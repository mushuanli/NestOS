
/** Optional field constraints; workflows and hosts choose their own upload policy. */
export interface FlowImageConstraints {
    maxItems?: number;
    maxBytes?: number;
    mimeTypes?: string[];
}

export function validImageConstraints(value: FlowImageConstraints = {}): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return [value.maxItems, value.maxBytes].every(limit => limit === undefined || Number.isSafeInteger(limit) && limit > 0)
        && (value.mimeTypes === undefined || Array.isArray(value.mimeTypes) && value.mimeTypes.length > 0
            && value.mimeTypes.every(type => typeof type === 'string' && /^image\/[a-z0-9.+-]+$/i.test(type)));
}

export type FlowImagePart = {type: 'image_url'; image_url: {url: string}} | {type: 'image'; source: {type: 'asset'; asset: {mimeType: string; bytes: number; sha256: string; [key: string]: unknown}}};

/** Upload values use the existing multimodal message content contract. */
export function validFlowImages(value: unknown, constraints: FlowImageConstraints = {}): value is FlowImagePart[] {
    if (!validImageConstraints(constraints) || !Array.isArray(value) || !value.length
        || constraints.maxItems !== undefined && value.length > constraints.maxItems) return false;
    let bytes = 0;
    for (const part of value) {
        if (!part) return false;
        const size = part.type === 'image' && part.source?.type === 'asset' ? assetImageBytes(part.source.asset, constraints)
            : part.type === 'image_url' && typeof part.image_url?.url === 'string' ? inlineImageBytes(part.image_url.url, constraints) : undefined;
        if (size === undefined) return false;
        bytes += size;
        if (constraints.maxBytes !== undefined && bytes > constraints.maxBytes) return false;
    }
    return true;
}

function inlineImageBytes(url: string, constraints: FlowImageConstraints): number | undefined {
    if (constraints.maxBytes !== undefined && url.length > Math.ceil(constraints.maxBytes / 3) * 4 + 256) return undefined;
    const prefix = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(url);
    if (!prefix || constraints.mimeTypes && !constraints.mimeTypes.includes(prefix[1])) return undefined;
    const data = url.slice(prefix[0].length);
    if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
    return data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

function assetImageBytes(asset: Record<string, unknown>, constraints: FlowImageConstraints): number | undefined {
    if (!asset || typeof asset !== 'object' || typeof asset.mimeType !== 'string' || !/^image\/(?:png|jpeg|webp)$/.test(asset.mimeType)
        || constraints.mimeTypes && !constraints.mimeTypes.includes(asset.mimeType) || !Number.isSafeInteger(asset.bytes) || Number(asset.bytes) < 1
        || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) return;
    if (asset.kind === 'input' ? typeof asset.id !== 'string' || !/^[a-f0-9-]{36}$/.test(asset.id)
        : !['sessionId', 'taskId', 'owner', 'name'].every(key => typeof asset[key] === 'string' && asset[key])) return;
    return Number(asset.bytes);
}

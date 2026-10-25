/** A file argument carries immutable content identity, never a browser File or a remote URL. */
export interface FlowFilePart {
    type: 'file'; name: string;
    source: {type: 'asset'; asset: {mimeType: string; bytes: number; sha256: string; [key: string]: unknown}};
}
export interface FlowFileConstraints {minItems?: number; maxItems?: number; maxBytes?: number; mimeTypes?: string[]}

export function validFileConstraints(value: FlowFileConstraints = {}): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (Object.keys(value).some(key => !['minItems', 'maxItems', 'maxBytes', 'mimeTypes'].includes(key))) return false;
    return validBounds(value) && (value.mimeTypes === undefined || Array.isArray(value.mimeTypes) && value.mimeTypes.length > 0
        && value.mimeTypes.every(type => typeof type === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type)));
}
function validBounds(value: FlowFileConstraints): boolean {
    return [value.minItems, value.maxItems, value.maxBytes].every(limit => limit === undefined || Number.isSafeInteger(limit) && limit >= 0)
        && (value.minItems === undefined || value.maxItems === undefined || value.minItems <= value.maxItems);
}

export function validFlowFiles(value: unknown, constraints: FlowFileConstraints = {}): value is FlowFilePart[] {
    if (!validFileConstraints(constraints) || !Array.isArray(value)) return false;
    if (!withinBounds(value.length, 0, constraints)) return false;
    let bytes = 0;
    for (const part of value) {
        const asset = fileAsset(part);
        if (!asset || !allowedMime(asset.mimeType, constraints)) return false;
        bytes += asset.bytes;
        if (!withinBounds(value.length, bytes, constraints)) return false;
    }
    return true;
}
function withinBounds(count: number, bytes: number, constraints: FlowFileConstraints): boolean {
    return Number.isSafeInteger(bytes) && (constraints.minItems === undefined || count >= constraints.minItems)
        && (constraints.maxItems === undefined || count <= constraints.maxItems) && (constraints.maxBytes === undefined || bytes <= constraints.maxBytes);
}
function allowedMime(mimeType: string, constraints: FlowFileConstraints): boolean {
    return !constraints.mimeTypes || constraints.mimeTypes.some(type => type.toLowerCase() === mimeType.toLowerCase());
}
function fileAsset(value: unknown): FlowFilePart['source']['asset'] | undefined {
    if (!value || typeof value !== 'object') return;
    const part = value as FlowFilePart;
    if (part.type !== 'file' || typeof part.name !== 'string' || !part.name || part.source?.type !== 'asset') return;
    const asset = part.source.asset;
    if (validMetadata(asset) && knownIdentity(asset)) return asset;
}
function validMetadata(asset: FlowFilePart['source']['asset']): boolean {
    return !!asset && typeof asset.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(asset.mimeType)
        && Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256);
}
function knownIdentity(asset: Record<string, unknown>): boolean {
    if (asset.kind === 'input') return typeof asset.id === 'string' && /^[a-f0-9-]{36}$/.test(asset.id);
    return asset.kind === undefined && ['sessionId', 'taskId', 'owner', 'name'].every(key => typeof asset[key] === 'string' && !!asset[key]);
}

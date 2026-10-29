export type ModelPriceUnit = 'million-tokens' | 'image' | 'million-characters' | 'ten-thousand-characters' | 'second' | 'minute';
export interface ModelPriceBand {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
    conditions?: {minInputTokens?: number; maxInputTokens?: number; minImagePixels?: number; maxImagePixels?: number;
        period?: 'peak' | 'off-peak'; operation?: 'image.generate' | 'image.layer'; validUntil?: string;
        minInputImages?: number; maxInputImages?: number; includesVideo?: boolean; videoHeight?: number};
}
export interface ModelReferencePrice {
    modelIds: string[];
    sourceUrl?: string;
    currency: 'USD' | 'CNY';
    unit: ModelPriceUnit;
    /** Token references default to standard text rates; media token rates declare their modality. */
    tokenModality?: 'text' | 'audio' | 'video';
    status?: 'unverified' | 'variable';
    rates: ModelPriceBand[];
}
export interface ProviderPriceCatalog {
    sourceUrl: string;
    reviewedAt: string;
    status: 'published' | 'account' | 'subscription' | 'unknown';
    models: ModelReferencePrice[];
}
/** Vendor list prices retain their original currency and units; never use them as a paid receipt. */
export interface ModelPriceCatalog {version: number; providers: Record<string, ProviderPriceCatalog>;}

export function getProviderPriceCatalog(catalog: ModelPriceCatalog | undefined, providerId: string): ProviderPriceCatalog | undefined {
    return catalog && Object.hasOwn(catalog.providers, providerId) ? catalog.providers[providerId] : undefined;
}

/** A price belongs to an exact provider and API model ID, including explicitly documented aliases. */
export function resolveModelReferencePrice(catalog: ModelPriceCatalog | undefined, providerId: string, modelId: string): ModelReferencePrice | undefined {
    return getProviderPriceCatalog(catalog, providerId)?.models.find(model => model.modelIds.includes(modelId));
}

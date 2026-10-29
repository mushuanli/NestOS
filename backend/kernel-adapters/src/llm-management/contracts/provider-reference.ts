export type ApiSupport = 'implemented' | 'partial' | 'unsupported';
export interface ApiReferenceEntry {
    id: string; name: string; support: ApiSupport; notes?: string;
}
export interface ProviderApiReference {
    version: number;
    reviewedAt: string;
    scope: string;
    sources: Array<{id: string; title: string; url: string}>;
    models: Array<ApiReferenceEntry & {kind: 'resource' | 'body-model'}>;
    formats: Array<ApiReferenceEntry & {wireValue: string; sampleRates: number[]; defaultSampleRate: number}>;
    voices: Array<{id: string; name: string; languages: string[]; notes?: string}>;
    parameters: Array<{path: string; name: string; type: string; required: boolean; support: ApiSupport;
        clientField?: string; default?: string | number | boolean; min?: number; max?: number; notes?: string}>;
    discovery: {models: string; voices: string};
    response: {audioCode: number; completionCode: number; emptyCompletionData: boolean};
    notes: string[];
}

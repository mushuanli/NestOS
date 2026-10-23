import type { ConnectionMeta } from '@itookit/driver-llm/contracts';
import type { ModelOperation } from '@itookit/kernel-adapters/contracts';

/** Selection data only; credentials and arbitrary metadata remain in the live catalog. */
export interface FlowConnectionSelection {
    id: string;
    providerId: string;
    model: string;
    tiers?: ConnectionMeta['tiers'];
    protocol?: ConnectionMeta['protocol'];
    /** Effective protocols for models actually admitted, separate from the explicit override. */
    modelProtocols?: Record<string, NonNullable<ConnectionMeta['protocol']>>;
    baseURL: string;
    operationModels: Partial<Record<ModelOperation, string>>;
    mediaEndpoints: Partial<Record<ModelOperation, string>>;
}
export interface FlowConnectionSnapshot { connections: FlowConnectionSelection[] }

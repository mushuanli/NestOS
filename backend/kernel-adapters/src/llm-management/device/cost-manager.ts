// @file: device-llm/device/cost-manager.ts
//
// CostManager — wrapper around CostStore exposing recordCost / queryCosts.

import type { ILLMManagementService } from '@itookit/kernel-adapters/contracts';
import { CostStore } from '../cost/cost-store';

export class CostManager {
    constructor(private readonly costStore: CostStore) {}

    async recordCost(params: Parameters<ILLMManagementService['recordCost']>[0]): Promise<void> {
        await this.costStore.recordCost(params);
    }

    async queryCosts(filter?: {
        dateFrom?: string;
        dateTo?: string;
        providerId?: string;
    }): Promise<import('@itookit/kernel-adapters/contracts').CostRecord[]> {
        return this.costStore.queryAll(filter);
    }

    queryBySession(sessionId: string): Promise<import('@itookit/kernel-adapters/contracts').CostRecord[]> {
        return this.costStore.queryBySession(sessionId);
    }

    queryAll(filter?: { providerId?: string; dateFrom?: string; dateTo?: string }): Promise<import('@itookit/kernel-adapters/contracts').CostRecord[]> {
        return this.costStore.queryAll(filter);
    }
}

// @file: device-llm/cost/cost-store.ts
// cost.seq 的读写封装。
// key = `{sessionId}|{providerId}|{date}`，同 key 每次请求累加。
// 一个 session 切换 provider 产生独立记录（不同 key）。

import type { IFileSystem } from '@itookit/vfs-core';
import type { CostRecord } from '@itookit/kernel-adapters/contracts';
import { COST_SEQ_PATH } from '../constants/pricing';

const SEQ_FILE_NAME = 'cost.seq';
const SEQ_PARENT    = '/llm';

export class CostStore {
    constructor(private readonly engine: IFileSystem) {}

    /** 确保 cost.seq 文件存在（init 时调用） */
    async ensureFile(): Promise<void> {
        const seq = this.engine.meta.seq;
        if (!seq) return; // backend doesn't support seqfiles, skip silently

        const exists = await this.engine.driver.exists(COST_SEQ_PATH);
        if (exists) return;

        // Ensure parent directory exists
        const parentExists = await this.engine.driver.exists(SEQ_PARENT);
        if (!parentExists) {
            await this.engine.driver.createDirectory({ name: 'llm', parentPath: null });
        }

        await this.engine.driver.createFile({
            name: SEQ_FILE_NAME,
            parentPath: SEQ_PARENT,
            type: 'seqfile',
        });
    }

    /**
     * 记录一次请求费用，累加到对应 key。
     * key = `{sessionId}|{providerId}|{YYYY-MM-DD}`
     */
    async recordCost(params: {
        sessionId: string;
        providerId: string;
        connectionId: string;
        modelId: string;
        usage: {
            inputTokens: number;
            outputTokens: number;
            cacheWriteTokens?: number;
            cacheReadTokens?: number;
            cost: number;
        };
    }): Promise<void> {
        const seq = this.engine.meta.seq;
        if (!seq) return;

        const date = new Date().toISOString().slice(0, 10);
        const key  = `${params.sessionId}|${params.providerId}|${date}`;

        const existing = await seq.getEntry(COST_SEQ_PATH, key);
        let record: CostRecord;

        if (existing) {
            record = JSON.parse(existing) as CostRecord;
            record.inputTokens      += params.usage.inputTokens;
            record.outputTokens     += params.usage.outputTokens;
            record.cacheWriteTokens  = (record.cacheWriteTokens ?? 0) + (params.usage.cacheWriteTokens ?? 0);
            record.cacheReadTokens   = (record.cacheReadTokens  ?? 0) + (params.usage.cacheReadTokens  ?? 0);
            record.cost             += params.usage.cost;
            record.requests         += 1;
        } else {
            record = {
                sessionId:       params.sessionId,
                providerId:      params.providerId,
                connectionId:    params.connectionId,
                modelId:         params.modelId,
                date,
                inputTokens:     params.usage.inputTokens,
                outputTokens:    params.usage.outputTokens,
                cacheWriteTokens: params.usage.cacheWriteTokens,
                cacheReadTokens:  params.usage.cacheReadTokens,
                cost:            params.usage.cost,
                requests:        1,
            };
        }

        await seq.setEntry(COST_SEQ_PATH, key, JSON.stringify(record));
    }

    /**
     * 按 session 查询（高效：keyPrefix = `{sessionId}|`）
     */
    async queryBySession(sessionId: string): Promise<CostRecord[]> {
        return this.walkWithPrefix(`${sessionId}|`);
    }

    /**
     * 按 session + provider 查询（高效：keyPrefix = `{sessionId}|{providerId}|`）
     */
    async queryBySessionProvider(sessionId: string, providerId: string): Promise<CostRecord[]> {
        return this.walkWithPrefix(`${sessionId}|${providerId}|`);
    }

    /**
     * 全量查询，支持可选过滤条件（O(n) 遍历）
     */
    async queryAll(filter?: {
        providerId?: string;
        dateFrom?: string;   // YYYY-MM-DD
        dateTo?: string;     // YYYY-MM-DD
    }): Promise<CostRecord[]> {
        const records = await this.walkWithPrefix('');
        if (!filter) return records;

        return records.filter(r => {
            if (filter.providerId && r.providerId !== filter.providerId) return false;
            if (filter.dateFrom   && r.date < filter.dateFrom)           return false;
            if (filter.dateTo     && r.date > filter.dateTo)             return false;
            return true;
        });
    }

    private async walkWithPrefix(keyPrefix: string): Promise<CostRecord[]> {
        const seq = this.engine.meta.seq;
        if (!seq) return [];

        const records: CostRecord[] = [];
        await seq.walkEntries(
            COST_SEQ_PATH,
            (entry) => {
                try {
                    records.push(JSON.parse(entry.value) as CostRecord);
                } catch { /* skip malformed entries */ }
                return true;
            },
            keyPrefix ? { keyPrefix } : undefined,
        );
        return records;
    }
}

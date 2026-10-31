import {collectionExecutor, scannerExecutor} from '@itookit/app-contracts';
import { scanRules, type TwinScanRules } from './scan-rules';
import { TWIN_KINDS, type TwinMemoryKind } from './domain';
import type { TwinRecordFamily, TwinRecordWrite } from './contracts';

export interface TwinScanPlanInput {
    executor?: import('@itookit/app-contracts').TwinScannerExecutor;
    collection?: import('@itookit/app-contracts').TwinCollectionExecutor;
    maxOutputTokens?: number;
    runTokenLimit?: number;
    rules?: TwinScanRules; autoConfirm?: boolean; focus?: string;
    name: string; sourceIds: string[]; connectionId: string; kinds: TwinMemoryKind[];
    mode: 'analyze' | 'reconcile' | 'collect'; trigger: 'manual' | 'interval' | 'changes' | 'event';
    intervalMinutes: number; tokenLimit: number; enabled: boolean;
}
export interface TwinScanPlan extends TwinScanPlanInput { connectionFingerprint: string; createdAt: number; updatedAt: number; }
export type TwinScanState = 'queued' | 'running' | 'succeeded' | 'paused' | 'failed' | 'cancelled' | 'interrupted';
export interface TwinScanRun {
    collectionProgress?: import('@itookit/app-contracts').TwinCollectionProgress;
    executor?: import('@itookit/app-contracts').TwinScannerExecutor;
    collection?: import('@itookit/app-contracts').TwinCollectionExecutor;
    maxOutputTokens?: number;
    runTokenLimit?: number;
    budgetUnlimited?: boolean;
    errorDetail?: string;
    rules?: TwinScanRules; autoConfirm?: boolean; focus?: string;
    planId: string; planRevision: string; name: string; sourceIds: string[]; completedSourceIds: string[];
    connectionId: string; connectionFingerprint: string; kinds: TwinMemoryKind[]; mode: 'analyze' | 'reconcile' | 'collect';
    state: TwinScanState; trigger: 'manual' | 'interval' | 'changes' | 'event'; singleBatch: boolean;
    tokenLimit: number; reservedTokens: number; spentTokens: number;
    createdAt: number; startedAt: number; finishedAt: number; owner: string; fence: number; error: string;
}
export interface TwinScanCheckpoint { sourceId: string; sourceHash: string; incarnation: string; offset: number; complete: boolean; }
import type { TwinScanScope } from '@itookit/app-contracts';
export type { TwinScanScope } from '@itookit/app-contracts';
export interface TwinScanGuard {
    conditions: Array<{ family: TwinRecordFamily; id: string; expectedRevision: string | null }>;
    writes: TwinRecordWrite[];
}
export interface TwinScanCharge { reserve?: number; settle?: { reserved: number; spent: number }; }
export type TwinScanGuardPort = (scope: TwinScanScope, charge?: TwinScanCharge) => Promise<TwinScanGuard>;
export const SCAN_TERMINAL: readonly TwinScanState[] = ['succeeded', 'paused', 'failed', 'cancelled', 'interrupted'];

export function scanInput(input: TwinScanPlanInput): TwinScanPlanInput {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200
        || typeof input.connectionId !== 'string' || (input.mode !== 'collect' && !input.connectionId.trim()) || input.connectionId.length > 200
        || typeof input.enabled !== 'boolean') invalid();
    if (input.mode === 'collect' && !input.collection || input.collection && input.mode !== 'collect' && !input.rules?.include.length) throw new Error('TWIN_COLLECTION_SCOPE_REQUIRED');
    if (input.collection && input.trigger === 'changes') throw new Error('TWIN_COLLECTION_INTERVAL_REQUIRED');
    if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 128 || input.maxOutputTokens > 8192)) throw new Error('TWIN_INVALID_OUTPUT_LIMIT');
    if (input.runTokenLimit !== undefined && (!Number.isSafeInteger(input.runTokenLimit) || input.runTokenLimit < 0 || input.runTokenLimit > 10000000)) invalid();
    if (input.autoConfirm !== undefined && typeof input.autoConfirm !== 'boolean') invalid();
    identifiers(input.sourceIds, 10000, Boolean(input.rules) || input.mode === 'collect');
    const rules = input.rules ? scanRules(input.rules) : undefined;
    if (input.focus !== undefined && (typeof input.focus !== 'string' || input.focus.length > 2000)) invalid();
    if (!Array.isArray(input.kinds) || !input.kinds.length || input.kinds.some(kind => !TWIN_KINDS.includes(kind))) invalid();
    if (!['analyze', 'reconcile', 'collect'].includes(input.mode) || !['manual', 'interval', 'changes', 'event'].includes(input.trigger)) invalid();
    if (!Number.isSafeInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 10080
        || !Number.isSafeInteger(input.tokenLimit) || input.tokenLimit < 0 || input.tokenLimit > 10000000) invalid();
    return { ...(input.collection ? {collection: collectionExecutor(input.collection)} : {}), ...(input.maxOutputTokens !== undefined ? {maxOutputTokens: input.maxOutputTokens} : {}), ...(input.executor ? {executor: scannerExecutor(input.executor)} : {}), ...(input.runTokenLimit !== undefined ? {runTokenLimit: input.runTokenLimit} : {}), autoConfirm: input.autoConfirm ?? !!rules, ...(rules ? { rules } : {}), focus: input.focus?.trim() ?? '', name: input.name.trim(), sourceIds: [...new Set(input.sourceIds)], connectionId: input.connectionId.trim(),
        kinds: TWIN_KINDS.filter(kind => input.kinds.includes(kind)), mode: input.mode, trigger: input.trigger,
        intervalMinutes: input.intervalMinutes, tokenLimit: input.tokenLimit, enabled: input.enabled };
}
export function identifiers(value: unknown, maximum: number, allowEmpty = false): asserts value is string[] {
    if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > maximum
        || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) invalid();
}
export const scanError = (error: unknown) => error instanceof Error && /^TWIN_[A-Z_]+$/.test(error.message) ? error.message : 'TWIN_SCAN_FAILED';
export function invalid(): never { throw new Error('TWIN_INVALID_SCAN_PLAN'); }

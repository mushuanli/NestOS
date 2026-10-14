import type { ContentRef } from '../domain/durable';
import type { ContextGcEntry, ContextGcOptions, ContextGcPolicy, ContextGcResult, ContextGcView, IContextGcStore } from './types';
import { contextReferences } from './references';

const defaults = { retentionMs: 86_400_000, maxObjects: 10_000, maxRoots: 10_000,
    maxBytes: 64 * 1024 * 1024, maxDeletes: 128, maxDurationMs: 1000 };
class BudgetExceeded extends Error {}

export function createContextGc(store: IContextGcStore, policy: ContextGcPolicy = {}) {
    const limits = { ...defaults, ...policy };
    for (const value of Object.values(limits)) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid context GC policy');
    }
    return { async collect(options: ContextGcOptions = {}): Promise<ContextGcResult> {
        const result: ContextGcResult = { status: options.dryRun ? 'dry-run' : 'collected',
            scanned: 0, marked: 0, candidates: 0, deleted: 0, reclaimedBytes: 0 };
        try {
            const now = options.now ?? Date.now();
            if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid GC clock');
            const collected = await store.exclusive(view => collect(view, limits, now, options, result));
            if (collected === null) result.status = 'busy';
        } catch (error) {
            result.deleted = 0;
            result.reclaimedBytes = 0;
            result.status = error instanceof BudgetExceeded ? 'budget' : 'failed';
            result.error = error instanceof Error ? error.message : String(error);
        }
        return result;
    } };
}

async function collect(view: ContextGcView, limits: typeof defaults, now: number,
    options: ContextGcOptions, result: ContextGcResult): Promise<void> {
    const entries: ContextGcEntry[] = [];
    const started = Date.now();
    const checkTime = () => {
        if (Date.now() - started >= limits.maxDurationMs) throw new BudgetExceeded('Context GC time budget exceeded');
    };
    for await (const entry of view.entries()) {
        checkTime();
        if (++result.scanned > limits.maxObjects) throw new BudgetExceeded('Context object scan budget exceeded');
        if (!/^[a-f0-9]{64}$/.test(entry.id) || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
            || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Invalid context GC metadata');
        entries.push(entry);
    }
    if (!entries.length) return;
    const marked = await mark(view, limits, checkTime);
    result.marked = marked.size;
    const candidates = entries.filter(entry => !marked.has(entry.id) && now - entry.createdAt >= limits.retentionMs);
    result.candidates = candidates.length;
    // No deletion occurs until the entire root graph has been verified.
    for (const entry of candidates.slice(0, limits.maxDeletes)) {
        checkTime();
        if (options.dryRun) continue;
        await view.remove(entry.id);
        result.deleted++;
        result.reclaimedBytes += entry.bytes;
    }
}

async function mark(view: ContextGcView, limits: typeof defaults, checkTime: () => void): Promise<Set<string>> {
    const marked = new Map<string, ContentRef>();
    let bytes = 0;
    const charge = (size: number) => {
        checkTime();
        bytes += size;
        if (bytes > limits.maxBytes) throw new BudgetExceeded('Context mark byte budget exceeded');
    };
    const pending = await rootReferences(view, limits.maxRoots, charge);
    while (pending.length) {
        const ref = pending.pop()!;
        const previous = marked.get(ref.id);
        if (previous && (previous.sha256 !== ref.sha256 || previous.bytes !== ref.bytes)) throw new Error('Conflicting context references');
        if (previous) continue;
        if (marked.size >= limits.maxObjects) throw new BudgetExceeded('Context mark object budget exceeded');
        charge(ref.bytes);
        const content = await view.read(ref);
        marked.set(ref.id, ref);
        for (const child of contextReferences(ref.mediaType === 'application/json' ? JSON.parse(content) : content)) pending.push(child);
    }
    return new Set(marked.keys());
}

async function rootReferences(view: ContextGcView, limit: number, charge: (bytes: number) => void): Promise<ContentRef[]> {
    const refs: ContentRef[] = [];
    let count = 0;
    for await (const root of view.roots()) {
        if (++count > limit) throw new BudgetExceeded('Context root scan budget exceeded');
        charge(new TextEncoder().encode(JSON.stringify(root)).length);
        for (const ref of contextReferences(root)) refs.push(ref);
    }
    return refs;
}

import type { FlowJoinConfig, JsonValue } from '../../contracts';
import { resolve } from '../operations';
import type { ResultSlot } from './types';

export type FlowReducer = (previous: JsonValue | undefined, updates: Record<string, ResultSlot>) => JsonValue;

/** Versioned deterministic reducers; registration is owned by the runtime host. */
export class FlowReducerRegistry {
    private readonly reducers = new Map<string, FlowReducer>();
    constructor() {
        this.register('latest@1', (previous, updates) => ({ ...record(previous), ...updates }) as unknown as JsonValue);
        this.register('append@1', (previous, updates) => [...(Array.isArray(previous) ? previous : []), ...Object.values(updates)] as unknown as JsonValue);
    }
    register(id: string, reducer: FlowReducer): void {
        if (!/^[A-Za-z][\w.-]*@\d+$/.test(id) || this.reducers.has(id)) throw new Error(`Invalid or duplicate reducer: ${id}`);
        this.reducers.set(id, reducer);
    }
    has(id: string): boolean { return this.reducers.has(id); }
    reduce(config: FlowJoinConfig | undefined, previous: JsonValue | undefined, updates: Record<string, ResultSlot>): JsonValue {
        const id = config?.reducer ?? 'latest@1';
        const reducer = this.reducers.get(id);
        if (!reducer) throw new Error(`Unknown reducer: ${id}`);
        return reducer(structuredClone(previous), structuredClone(updates));
    }
}

/** Batch order follows declared selection, never completion order. */
export function orderedUpdates(keys: string[], received: Record<string, ResultSlot>): Record<string, ResultSlot> {
    return Object.fromEntries(keys.filter(key => received[key]).map(key => [key, received[key]]));
}

export function projectSummary(config: FlowJoinConfig | undefined, summary: JsonValue): JsonValue {
    if (!config?.projection) return summary;
    const value = resolve(config.projection, { summary });
    if (value === undefined) throw new Error('Missing aggregate projection');
    return value as JsonValue;
}
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

import type { JsonValue, SessionHandle } from '@itookit/durable-kernel';
import type { SchedulerCheckpoint } from './scheduler-checkpoint';
import { decodeSchedulerCheckpoint } from './checkpoint-decoder';
import { isRecord } from './graph-decoder';

const frozenFields = new Set(['invocationIdentityVersion', 'spec', 'nodes', 'edges', 'appliedPatches', 'nodeDefaults', 'nodeConnections',
    'catalog', 'parameters', 'sessionContext']);
const checkpointKey = (rootTaskId: string) => `flow.run.${rootTaskId}.scheduler`;
type Reader = Pick<SessionHandle, 'getShared'>;

/** Keep every immutable graph revision reachable from its historical checkpoint. */
export class SchedulerCheckpointWriter {
    private sequence = 0;
    private previous?: { json: string; key: string };

    /** The caller supplies a lease-fenced Session; publish the pointer only after its graph exists. */
    async save(session: Pick<SessionHandle, 'setShared'>, rootTaskId: string, epoch: number,
        checkpoint: SchedulerCheckpoint): Promise<void> {
        if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid Flow checkpoint writer epoch');
        const entries = Object.entries(checkpoint);
        const frozen = JSON.stringify(Object.fromEntries(entries.filter(([key]) => frozenFields.has(key))));
        const key = checkpointKey(rootTaskId);
        if (this.previous?.json !== frozen) {
            const reference = `${key}.frozen.${epoch}.${++this.sequence}`;
            await session.setShared(reference, { version: 1, value: JSON.parse(frozen) }, { expectedVersion: null });
            this.previous = { json: frozen, key: reference };
        }
        const state = Object.fromEntries(entries.filter(([name]) => !frozenFields.has(name)));
        const value = JSON.parse(JSON.stringify({ version: 2, frozenKey: this.previous!.key, state })) as JsonValue;
        await session.setShared(key, value);
    }
}

/** Resolve both legacy full checkpoints and compact checkpoints without consulting current definitions. */
export async function readFlowSchedulerCheckpoint(session: Reader, rootTaskId: string,
    fallback?: unknown): Promise<SchedulerCheckpoint | undefined> {
    const key = checkpointKey(rootTaskId);
    const saved = await session.getShared(key);
    const value = saved ? saved.value : fallback;
    if (!isRecord(value) || value.version !== 2) return decodeSchedulerCheckpoint(value);
    const reference = frozenReference(value, key);
    const component = await session.getShared(reference);
    if (!component) throw new Error(`Flow scheduler checkpoint frozen component is missing: ${rootTaskId}`);
    if (component.version !== 1 || !isRecord(component.value) || component.value.version !== 1
        || !isRecord(component.value.value) || Object.keys(component.value.value).some(name => !frozenFields.has(name))) {
        throw new TypeError('Invalid Flow scheduler checkpoint: frozen component');
    }
    return decodeSchedulerCheckpoint({ ...value.state as object, ...component.value.value });
}

function frozenReference(value: Record<string, unknown>, key: string): string {
    const prefix = `${key}.frozen.`;
    if (typeof value.frozenKey !== 'string' || !value.frozenKey.startsWith(prefix)
        || !/^[1-9]\d*\.[1-9]\d*$/.test(value.frozenKey.slice(prefix.length))
        || !isRecord(value.state) || value.state.version !== 1
        || Object.keys(value.state).some(name => frozenFields.has(name))) {
        throw new TypeError('Invalid Flow scheduler checkpoint: frozen reference');
    }
    return value.frozenKey;
}

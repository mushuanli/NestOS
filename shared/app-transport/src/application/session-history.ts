import {FSError} from '@itookit/vfs-core';
import {SnapshotCodec, wireSize} from '../rpc/snapshot-codec';

type Snapshot = Record<string, any>;
type History = readonly unknown[];
interface Entry {rows: History; units: number}
interface Envelope { $sessionView: {state: Snapshot; scope: string; field: string}; histories: Record<string, History> }
const maxEntries = 8, maxUnits = 4 * 1024 * 1024;

/** History is keyed by Session and branch so switching the active binding only changes its head. */
export class SessionHistory {
    private readonly entries = new Map<string, Entry>();
    private readonly codec = new SnapshotCodec();
    private units = 0;
    project(source: Snapshot, field: string, rows: History): Envelope {
        const scope = JSON.stringify([source.sessionId ?? '', source.view?.manifest?.currentBranch ?? '']);
        const previous = this.entries.get(scope), encoded = this.codec.encode(rows);
        const units = encoded === undefined ? maxUnits + 1 : wireSize(encoded);
        this.units -= previous?.units ?? 0; this.entries.delete(scope);
        this.entries.set(scope, {rows, units}); this.units += units;
        while (this.entries.size > 1 && (this.entries.size > maxEntries || this.units > maxUnits)) {
            const key = this.entries.keys().next().value!;
            this.units -= this.entries.get(key)!.units; this.entries.delete(key);
        }
        const state = {...source}; delete state[field];
        return {$sessionView: {state, scope, field}, histories: Object.fromEntries([...this.entries].map(([key, entry]) => [key, entry.rows]))};
    }
}

/** Public callers still receive the original SessionSnapshot, never the transport cache envelope. */
export function readSessionHistory(value: Snapshot): Snapshot {
    if (!value?.$sessionView) return value;
    const {state, scope, field} = value.$sessionView;
    const rows = value.histories?.[scope];
    if (!state || !['sessions', 'messages'].includes(field) || !Array.isArray(rows))
        throw new FSError('EIO', 'Session history baseline is missing');
    return {...state, [field]: rows};
}

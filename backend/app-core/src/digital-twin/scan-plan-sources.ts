import type {TwinSourceData} from './domain';
import type {TwinDataRecord} from './records';
/** A local file may be visible through both a project view and an ordinary workspace view. */
export function uniqueScanSources(sources: TwinDataRecord<TwinSourceData>[]): TwinDataRecord<TwinSourceData>[] {
    const selected = new Map<string, TwinDataRecord<TwinSourceData>>();
    for (const source of sources) {
        const resource = source.data.resource;
        const key = resource?.kind === 'file' && resource.location === 'local' && resource.directoryPath
            ? JSON.stringify(['local-file', resource.directoryPath]) : source.id;
        const previous = selected.get(key);
        if (!previous || !previous.data.target.startsWith('project://') && source.data.target.startsWith('project://')) selected.set(key, source);
    }
    return [...selected.values()];
}

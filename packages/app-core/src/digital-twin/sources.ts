import { matchesRules, matchesLine } from './scan-rules';
import type { TwinScanPlan } from './scan-domain';
import type { TwinSettings } from './domain';
import { randomUUID } from '@itookit/common';
import { FSError } from '@itookit/vfs-core';
import type { TwinSourceContent, TwinSourceData, TwinSourceReader, TwinSourceSpec } from './domain';
import { TwinRecords, type TwinDataRecord } from './records';

export class TwinSources {
    private readonly observations = new Map<string, number>();
    observedAt(id: string): number | undefined { return this.observations.get(id); }
    constructor(private readonly records: TwinRecords, readonly reader: TwinSourceReader, readonly fingerprint: (id: string) => Promise<string>) {}

    async preview(spec: TwinSourceSpec): Promise<TwinSourceContent> { return this.reader.read(spec); }

    async add(spec: TwinSourceSpec, connectionId: string): Promise<string> {
        if (!connectionId.trim()) throw new Error('TWIN_CONNECTION_REQUIRED');
        if ((await this.records.list('source')).length >= 10000) throw new Error('TWIN_SOURCE_COUNT_LIMIT');
        const connectionFingerprint = await this.fingerprint(connectionId);
        const content = await this.preview(spec), id = randomUUID();
        const data: TwinSourceData = { ...spec, connectionId, connectionFingerprint, enabled: true, incarnation: randomUUID(),
            nativeIdentity: content.nativeIdentity, hash: content.hash, checkedAt: Date.now(), analyzedHash: '',
            offset: 0, status: 'available', characters: content.text.length };
        await this.records.save('source', id, data, null);
        return id;
    }

    async setEnabled(id: string, revision: string, enabled: boolean): Promise<void> {
        const source = await this.records.get<TwinSourceData>('source', id);
        if (!source || source.revision !== revision) throw new Error('TWIN_REVIEW_CONFLICT');
        await this.records.save('source', id, { ...source.data, enabled }, revision);
    }

    async reconcile(includeManaged = true): Promise<void> {
        for (const source of await this.records.list<TwinSourceData>('source')) {
            if (source.data.enabled && source.data.status !== 'deleted' && (includeManaged || !source.data.managed)) await this.check(source);
        }
    }
    async checkOne(id: string, verifyContent = false): Promise<void> {
        const source = await this.records.get<TwinSourceData>('source', id);
        if (!source?.data.enabled) throw new Error('TWIN_SOURCE_DENIED');
        if (source.data.managed || source.data.status !== 'deleted') await this.check(source, verifyContent);
    }

    async readCurrent(id: string): Promise<{ source: TwinDataRecord<TwinSourceData>; content: TwinSourceContent }> {
        const source = await this.records.get<TwinSourceData>('source', id);
        if (!source?.data.enabled || source.data.status === 'deleted') throw new Error('TWIN_SOURCE_DENIED');
        await this.check(source);
        const latest = await this.records.get<TwinSourceData>('source', id);
        if (!latest || latest.data.status !== 'available') throw new Error('TWIN_SOURCE_UNAVAILABLE');
        const content = await this.reader.read(latest.data);
        if (content.hash !== latest.data.hash || content.nativeIdentity !== latest.data.nativeIdentity) throw new Error('TWIN_SOURCE_CHANGED');
        return { source: latest, content };
    }

    private async allowed(source: TwinSourceData): Promise<boolean> {
        if (!source.resource) return false;
        const settings = (await this.records.get<TwinSettings>('settings', 'pot'))!.data;
        if ((settings.globalExclude ?? []).some(line => matchesLine(source.resource!, line))) return false;
        return (await this.records.list<TwinScanPlan>('scan-plan')).some(plan => plan.data.enabled
            && plan.data.rules && matchesRules(source.resource!, plan.data.rules));
    }
    private async check(source: TwinDataRecord<TwinSourceData>, verifyContent = false): Promise<void> {
        let data: TwinSourceData;
        try {
            if (source.data.managed && !await this.allowed(source.data)) throw new Error('TWIN_SOURCE_DENIED');
            if (await this.fingerprint(source.data.connectionId) !== source.data.connectionFingerprint) throw new Error('TWIN_CONNECTION_CHANGED');
            const version = await this.reader.probe?.(source.data);
            if (!verifyContent && version && version === source.data.observedVersion && source.data.status === 'available') return;
            const content = await this.reader.read(source.data);
            const changed = content.hash !== source.data.hash || content.nativeIdentity !== source.data.nativeIdentity;
            data = { ...source.data, ...(version ? { observedVersion: version } : {}), hash: content.hash, nativeIdentity: content.nativeIdentity, status: 'available',
                characters: content.text.length, ...(changed ? { incarnation: randomUUID(), offset: 0, analyzedHash: '' } : {}) };
        } catch (error) {
            data = { ...source.data, status: error instanceof FSError && error.code === 'ENOENT' ? 'deleted' : 'inaccessible' };
        }
        this.observations.set(source.id, Date.now());
        // Avoid changing the source revision on every read; it is a commit dependency.
        if (JSON.stringify(data) === JSON.stringify(source.data)) return;
        await this.records.save('source', source.id, { ...data, checkedAt: Date.now() }, source.revision);
    }
}

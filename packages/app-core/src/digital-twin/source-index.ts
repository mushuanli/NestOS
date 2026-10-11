import { retry } from './scan-store';
import { randomUUID } from '@itookit/common';
import { sha256HexSync } from '@itookit/llm-context';
import type { TwinSettings, TwinSourceData, TwinSourceCatalog, TwinDiscoveredSource } from './domain';
import type { TwinScanPlan } from './scan-domain';
import { matchesRules, matchesLine } from './scan-rules';
import { TwinSources } from './sources';
import { TwinRecords, type TwinDataRecord } from './records';
import { scopeOf } from './project-catalog';

/** The catalog is derived from project services; SeqFiles hold only source identity and progress. */
export class TwinSourceIndex {
    private syncing?: Promise<void>;
    private resync = false;
    private errors: string[] = [];
    constructor(private readonly records: TwinRecords, private readonly sources: TwinSources) {}
    status() { return { errors: this.errors }; }
    sync(): Promise<void> {
        if (this.syncing) { this.resync = true; return this.syncing; }
        return this.syncing = this.drain().finally(() => { this.syncing = undefined; });
    }
    private async drain(): Promise<void> {
        do { this.resync = false; await retry(() => this.update()); } while (this.resync);
    }
    async preview(rules: import('./scan-rules').TwinScanRules) {
        if (!this.sources.reader.discover) throw new Error('TWIN_PROJECT_CATALOG_UNAVAILABLE');
        const catalog = await this.sources.reader.discover(), settings = await this.records.get<TwinSettings>('settings', 'pot');
        const allowed = (resource: TwinDiscoveredSource) => matchesRules(resource, rules)
            && !(settings?.data.globalExclude ?? []).some(line => matchesLine(resource, line));
        return { resources: catalog.resources.filter(allowed), excluded: catalog.resources.filter(resource => !allowed(resource)), errors: catalog.errors };
    }
    private async update(): Promise<void> {
        const catalog = this.sources.reader.discover ? await this.sources.reader.discover() : null;
        if (!catalog) return;
        this.errors = catalog.errors;
        const plans = (await this.records.list<TwinScanPlan>('scan-plan')).filter(plan => plan.data.rules);
        if (!this.sources.reader.discover || (!plans.length && !(await this.records.list<TwinSourceData>('source')).some(source => source.data.managed))) return;
        const settings = (await this.records.get<TwinSettings>('settings', 'pot'))!.data;
        const fingerprint = settings.connectionId ? await this.sources.fingerprint(settings.connectionId).catch(() => {
            this.errors.push('TWIN_CONNECTION_UNAVAILABLE'); return '';
        }) : '';
        const existing = await this.records.list<TwinSourceData>('source'), byId = new Map(existing.map(source => [source.id, source])), seen = new Set<string>();
        for (const resource of catalog.resources) {
            const id = resourceId(resource); if (seen.has(id)) continue; seen.add(id);
            const enabled = Boolean(fingerprint) && plans.some(plan => plan.data.enabled && matchesRules(resource, plan.data.rules!))
                && !(settings.globalExclude ?? []).some(line => matchesLine(resource, line));
            const current = byId.get(id);
            const ignoredByRules = plans.some(plan => matchesRules(resource, { include: plan.data.rules!.include, exclude: [] })
                && plan.data.rules!.exclude.some(line => matchesLine(resource, line)))
                && !plans.some(plan => matchesRules(resource, plan.data.rules!));
            const retained = Boolean(current && !enabled && !ignoredByRules && fingerprint === current.data.connectionFingerprint
                && !(settings.globalExclude ?? []).some(line => matchesLine(resource, line)));
            if (enabled || current) await this.upsert(id, resource, enabled, retained, settings.connectionId ?? '', fingerprint, current);
        }
        for (const source of existing.filter(item => item.data.managed && !seen.has(item.id))) await this.missing(source, catalog);
    }
    private async upsert(id: string, resource: TwinDiscoveredSource, enabled: boolean, retained: boolean, connectionId: string, fingerprint: string, current?: TwinDataRecord<TwinSourceData>) {
        const spec = { kind: resource.kind, target: resource.target, label: resource.label };
        const data: TwinSourceData = current ? { ...current.data, ...spec, resource, enabled, retained, connectionId, connectionFingerprint: fingerprint }
            : { ...spec, resource, managed: true, enabled, connectionId, connectionFingerprint: fingerprint, incarnation: randomUUID(),
                nativeIdentity: '', hash: '', analyzedHash: '', offset: 0, checkedAt: 0, status: 'inaccessible', characters: 0 };
        if (current && current.data.connectionFingerprint !== fingerprint) { data.offset = 0; data.analyzedHash = ''; }
        if (!current || JSON.stringify(data) !== JSON.stringify(current.data)) await this.records.save('source', id, data, current?.revision ?? null);
        if (enabled) await this.sources.checkOne(id, true);
    }
    private async missing(source: TwinDataRecord<TwinSourceData>, catalog: TwinSourceCatalog) {
        const resource = source.data.resource!;
        if (!catalog.projects.includes(resource.projectId) || catalog.completeScopes.includes(scopeOf(resource))) {
            if (source.data.status !== 'deleted' || source.data.enabled) await this.records.save('source', source.id,
                { ...source.data, status: 'deleted', enabled: false }, source.revision);
        } else if (source.data.status !== 'inaccessible') await this.records.save('source', source.id,
            { ...source.data, status: 'inaccessible' }, source.revision);
    }
}
const resourceId = (resource: TwinDiscoveredSource) => 'auto-' + sha256HexSync(JSON.stringify([resource.kind, resource.target]));

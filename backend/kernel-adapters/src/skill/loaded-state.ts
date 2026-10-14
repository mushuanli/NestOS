import type { ISkillService, SkillVersionSnapshot, SkillVersionDrift } from '@itookit/tools/contracts';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import { KernelError, KernelErrorCode } from '@itookit/durable-kernel';
import { validateSkillVersionSnapshot } from './version-snapshot';

export interface LoadedSkillVersions {
    format: 2;
    ids: string[];
    snapshots: Record<string, SkillVersionSnapshot>;
    drifts: Record<string, SkillVersionDrift>;
}

/** An ID-only record cannot prove which definition an earlier host used. */
export function requireLoadedSkillVersions(value: unknown): void {
    const ids = parseLoadedSkillIds(value);
    const versions = parseLoadedSkillVersions(value);
    const missing = ids.find(id => !versions || !Object.hasOwn(versions.snapshots, id));
    if (missing) throw new Error(`Skill has no saved version; reload required: ${missing}`);
}

/** Merge a successful load into the durable identity set using the Session CAS boundary. */
export async function rememberLoadedSkill(id: string, state: EffectExecutionContext['sessionState'], snapshot?: SkillVersionSnapshot): Promise<void> {
    if (!state) return;
    await updateLoadedSkill(id, state, true, snapshot);
}

export async function forgetLoadedSkill(id: string, state: EffectExecutionContext['sessionState']): Promise<void> {
    if (!state) throw new Error('Durable Skill unload requires Session shared state');
    await updateLoadedSkill(id, state, false);
}

/**
 * Restore the live state after identity persistence failed. Only a load introduced
 * by this call may be undone — a Skill that was already loaded stays live, and a
 * rollback failure is reported alongside the original error instead of replacing it.
 */
export async function rollbackFailedLoad(
    service: Pick<ISkillService, 'unloadSkill'>,
    skillId: string,
    cause: unknown,
): Promise<never> {
    try {
        await service.unloadSkill(skillId);
    } catch (rollback) {
        throw new AggregateError([cause, rollback], `Skill "${skillId}" identity persistence failed and rollback failed`);
    }
    throw cause;
}

async function updateLoadedSkill(id: string, state: NonNullable<EffectExecutionContext['sessionState']>, loaded: boolean, snapshot?: SkillVersionSnapshot): Promise<void> {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Skill id is required');
    const key = 'kernel-adapters.skills.loaded';
    for (let attempt = 0; attempt < 3; attempt++) {
        const saved = await state.get(key);
        const ids = parseLoadedSkillIds(saved?.value);
        const nextIds = loaded ? [...new Set([...ids, id])] : ids.filter(value => value !== id);
        const versions = parseLoadedSkillVersions(saved?.value);
        const next = versions || snapshot ? updateVersions(versions, nextIds, id, loaded, snapshot) : nextIds;
        if (JSON.stringify(saved?.value ?? []) === JSON.stringify(next)) return;
        try { await state.set(key, next as never, saved?.version ?? null); return; }
        catch (error) {
            if (!(error instanceof KernelError) || error.code !== KernelErrorCode.CONFLICT || attempt === 2) throw error;
        }
    }
}

/** Shared records must not be silently repaired by an unrelated load or unload. */
export function parseLoadedSkillIds(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return parseLoadedSkillVersions(value)!.ids;
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) {
        throw new Error('Invalid loaded Skill identities');
    }
    return [...new Set(value as string[])];
}

export function parseLoadedSkillVersions(value: unknown): LoadedSkillVersions | undefined {
    if (value === undefined || value === null || Array.isArray(value)) return undefined;
    const record = value as LoadedSkillVersions;
    if (record.format !== 2 || !Array.isArray(record.ids) || !record.snapshots || !record.drifts
        || typeof record.snapshots !== 'object' || typeof record.drifts !== 'object') throw new Error('Invalid loaded Skill identities');
    const ids = parseLoadedSkillIds(record.ids);
    if (Array.isArray(record.snapshots) || Array.isArray(record.drifts)) throw new Error('Invalid loaded Skill identities');
    for (const [id, snapshot] of Object.entries(record.snapshots)) {
        if (!ids.includes(id) || validateSkillVersionSnapshot(snapshot).definition.id !== id) throw new Error('Invalid loaded Skill version identity');
    }
    for (const [id, drift] of Object.entries(record.drifts)) {
        if (!Object.hasOwn(record.snapshots, id) || !drift || drift.expectedDigest !== record.snapshots[id].digest
            || !/^[a-f0-9]{64}$/.test(drift.observedDigest) || !Number.isSafeInteger(drift.detectedAt) || drift.detectedAt < 0
            || drift.policy !== record.snapshots[id].policy) throw new Error('Invalid loaded Skill drift marker');
    }
    return structuredClone({ ...record, ids });
}

function updateVersions(previous: LoadedSkillVersions | undefined, ids: string[], id: string,
    loaded: boolean, snapshot?: SkillVersionSnapshot): LoadedSkillVersions {
    const result: LoadedSkillVersions = previous ?? { format: 2, ids, snapshots: {}, drifts: {} };
    result.ids = ids;
    if (snapshot) {
        const validated = validateSkillVersionSnapshot(snapshot);
        if (validated.definition.id !== id) throw new Error('Skill snapshot identity mismatch');
        Object.defineProperty(result.snapshots, id, { value: validated, enumerable: true, writable: true, configurable: true });
    }
    if (!loaded) delete result.snapshots[id];
    delete result.drifts[id];
    return result;
}

export async function persistSkillDrifts(service: ISkillService, state: EffectExecutionContext['sessionState']): Promise<void> {
    if (!state || !service.getSkillDrifts) return;
    for (let attempt = 0; attempt < 3; attempt++) {
        const saved = await state.get('kernel-adapters.skills.loaded');
        const versions = parseLoadedSkillVersions(saved?.value);
        if (!versions) return;
        const drifts = Object.fromEntries(Object.entries(service.getSkillDrifts()).filter(([id]) => versions.ids.includes(id)));
        if (JSON.stringify(drifts) === JSON.stringify(versions.drifts)) return;
        try { await state.set('kernel-adapters.skills.loaded', { ...versions, drifts } as never, saved!.version); return; }
        catch (error) { if (!(error instanceof KernelError) || error.code !== KernelErrorCode.CONFLICT || attempt === 2) throw error; }
    }
}

export async function withSkillDriftPersistence<T>(service: ISkillService, state: EffectExecutionContext['sessionState'],
    action: () => Promise<T>): Promise<T> {
    let result: T;
    try { result = await action(); }
    catch (error) {
        try { await persistSkillDrifts(service, state); }
        catch (persistence) { throw new AggregateError([error, persistence], 'Skill operation and drift persistence failed'); }
        throw error;
    }
    await persistSkillDrifts(service, state);
    return result;
}

import { runSessionSkillOperation } from './operation-queue';
import type { SessionSkillControls, ISkillService } from '@itookit/tools/contracts';
import type { Kernel } from '@itookit/durable-kernel';
import type { SessionCapabilityRegistry } from '../ports/capabilities';
import { forgetLoadedSkill, parseLoadedSkillIds, parseLoadedSkillVersions, rememberLoadedSkill, rollbackFailedLoad } from './loaded-state';

/** UI control uses Session shared state directly; it does not impersonate an Agent Effect. */
export function createSessionSkillControls(kernel: Pick<Kernel, 'openSession'>, registry: SessionCapabilityRegistry): SessionSkillControls {
    const serial = <T>(id: string, action: () => Promise<T>) => runSessionSkillOperation(registry, id, action);
    const list = async (sessionId: string, onlyLoaded: boolean) => {
            const session = await kernel.openSession(sessionId);
            const saved = (await session.getShared('kernel-adapters.skills.loaded'))?.value;
            const ids = parseLoadedSkillIds(saved);
            const versions = parseLoadedSkillVersions(saved);
            const scope = await registry.get(sessionId);
            const loaded = new Set([...ids, ...scope.skillService.getLoadedSkills().map(skill => skill.id)]);
            const all = new Set([...loaded, ...(onlyLoaded ? [] : scope.skillService.listSkills().map(skill => skill.id))]);
            return [...all].sort().map(id => {
                const skill = scope.skillService.getSkill(id);
                return { id, name: skill?.name ?? id, description: skill?.description ?? '', loaded: loaded.has(id),
                    enabled: !!skill?.enabled && !skill.disableModelInvocation && skill.triggerStrategy !== 'action',
                    // Definition-level enablement, independent of whether the input-side checkbox may
                    // load it: `/sk-<id>` exists exactly for the manual (action/silent) invocations.
                    definitionEnabled: !!skill?.enabled,
                    toolCount: skill?.tools.length ?? 0, toolIds: skill?.tools.map(tool => tool.toolId) ?? [], versionDigest: versions?.snapshots[id]?.digest,
                    versionPolicy: versions?.snapshots[id]?.policy, drift: versions?.drifts[id],
                    unversioned: ids.includes(id) && (!versions || !Object.hasOwn(versions.snapshots, id)) };
            });
    };
    return {
        list: id => serial(id, () => list(id, false)),
        listLoaded: id => serial(id, () => list(id, true)),
        load: (id, skillId) => serial(id, async () => {
            const session = await kernel.openSession(id);
            const state: NonNullable<import('@itookit/durable-kernel').EffectExecutionContext['sessionState']> = {
                get: key => session.getShared(key),
                set: (key, value, expectedVersion) => session.setShared(key, value, { expectedVersion }) };
            parseLoadedSkillIds((await state.get('kernel-adapters.skills.loaded'))?.value);
            const service = (await registry.get(id)).skillService;
            await service.refreshScopedSkills?.();
            return loadAndRemember(service, skillId, state);
        }),
        describe: (sessionId, skillId) => serial(sessionId, async () => {
            const skill = (await registry.get(sessionId)).skillService.getSkill(skillId);
            return skill ? { name: skill.name, type: skill.type, instructions: skill.instructions,
                triggerStrategy: skill.triggerStrategy, disableModelInvocation: skill.disableModelInvocation,
                enabled: skill.enabled } : undefined;
        }),
        mountByGlob: (sessionId, filePath) => serial(sessionId, async () => {
            requireEditorPath(filePath);
            (await registry.get(sessionId)).skillService.mountByGlob(filePath);
        }),
        unmountByGlob: (sessionId, filePath) => serial(sessionId, async () => {
            requireEditorPath(filePath);
            (await registry.get(sessionId)).skillService.unmountByGlob(filePath);
        }),
        onChange: async (sessionId, listener) => {
            if (typeof listener !== 'function') throw new Error('Skill change listener is required');
            return (await registry.get(sessionId)).skillService.onChange(listener);
        },
        unload: (sessionId, skillId) => serial(sessionId, async () => {
            const session = await kernel.openSession(sessionId);
            await forgetLoadedSkill(skillId, {
                get: key => session.getShared(key),
                set: (key, value, expectedVersion) => session.setShared(key, value, { expectedVersion }),
            });
            await (await registry.get(sessionId)).skillService.unloadSkill(skillId);
        }),
    };
}

/** Editor paths are virtual Session paths; reject anything that is not a non-empty string. */
function requireEditorPath(filePath: string): void {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('Editor file path is required');
}

async function loadAndRemember(service: ISkillService, id: string,
    state: NonNullable<import('@itookit/durable-kernel').EffectExecutionContext['sessionState']>): Promise<string[]> {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Skill id is required');
    const skill = service.getSkill(id);
    if (!skill?.enabled || skill.disableModelInvocation || skill.triggerStrategy === 'action') throw new Error(`Skill cannot be loaded into model context: ${id}`);
    const wasLoaded = service.getLoadedSkills().some(item => item.id === id);
    const versions = parseLoadedSkillVersions((await state.get('kernel-adapters.skills.loaded'))?.value);
    const previous = service.getSkillSnapshot?.(id)
        ?? (versions && Object.hasOwn(versions.snapshots, id) ? versions.snapshots[id] : undefined);
    const result = await (service.reloadSkill?.(id) ?? service.loadSkill(id));
    if (!result.success) throw new Error(result.error ?? `Failed to load Skill: ${id}`);
    try { await rememberLoadedSkill(id, state, result.snapshot); }
    catch (error) {
        if (previous && service.restoreSkillSnapshot) {
            try {
                const restored = await service.restoreSkillSnapshot(previous);
                if (!restored.success) throw new Error(restored.error ?? 'Previous Skill version cannot be restored');
            } catch (cleanup) { throw new AggregateError([error, cleanup], 'Skill reload persistence and rollback failed'); }
        } else if (!wasLoaded) await rollbackFailedLoad(service, id, error);
        throw error;
    }
    return result.toolIds;
}

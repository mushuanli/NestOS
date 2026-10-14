import type { Kernel } from '@itookit/durable-kernel';
import type { SessionCapabilityRegistry } from '../ports/capabilities';
import { buildSkillPromptContext } from './prompt-context';
import { rememberLoadedSkill, withSkillDriftPersistence, requireLoadedSkillVersions, rollbackFailedLoad } from './loaded-state';
import { runSessionSkillOperation } from './operation-queue';

/** Restore identities and freeze new-run instructions under the shared Skill queue. */
export function resolveSessionSkillContext(kernel: Kernel, registry: SessionCapabilityRegistry,
    sessionId: string, userMessage: string) {
    return runSessionSkillOperation(registry, sessionId, async () => {
        const session = await kernel.openSession(sessionId);
        const state: NonNullable<import('@itookit/durable-kernel').EffectExecutionContext['sessionState']> = {
            get: key => session.getShared(key), set: (key, value, expectedVersion) => session.setShared(key, value, { expectedVersion }) };
        const loaded = await session.getShared('kernel-adapters.skills.loaded');
        requireLoadedSkillVersions(loaded?.value);
        const scope = await registry.get(sessionId);
        return withSkillDriftPersistence(scope.skillService, state, async () => {
            await registry.restore(sessionId, loaded?.value);
            return await buildSkillPromptContext(scope.skillService, { userMessage,
                onAutoLoaded: id => rememberLoadedSkill(id, state, scope.skillService.getSkillSnapshot?.(id)) });
        });
    });
}

/** Resolve initial Agent selections through the same version authority as runtime loads. */
export function resolveSessionSelectedSkills(kernel: Kernel, registry: SessionCapabilityRegistry, sessionId: string, ids: string[]) {
    return runSessionSkillOperation(registry, sessionId, async () => {
        const session = await kernel.openSession(sessionId);
        const state: NonNullable<import('@itookit/durable-kernel').EffectExecutionContext['sessionState']> = {
            get: key => session.getShared(key), set: (key, value, expectedVersion) => session.setShared(key, value, { expectedVersion }) };
        const loaded = await state.get('kernel-adapters.skills.loaded'); requireLoadedSkillVersions(loaded?.value);
        const service = (await registry.get(sessionId)).skillService;
        return withSkillDriftPersistence(service, state, async () => {
            await registry.restore(sessionId, loaded?.value);
            const skills: import('@itookit/kernel-adapters/contracts').LLMSkill[] = [];
            for (const id of new Set(ids)) {
                const definition = service.getSkill(id);
                if (!definition?.enabled || definition.disableModelInvocation || definition.triggerStrategy === 'action') {
                    throw new Error(`Skill is missing, disabled, or unavailable for model invocation: ${id}`);
                }
                const wasLoaded = service.getLoadedSkills().some(skill => skill.id === id);
                const result = await service.loadSkill(id);
                if (!result.success) throw new Error(result.error ?? `Unable to load Skill: ${id}`);
                try { await rememberLoadedSkill(id, state, result.snapshot); }
                catch (error) { if (!wasLoaded) await rollbackFailedLoad(service, id, error); throw error; }
                const snapshot = result.snapshot;
                skills.push(snapshot ? { ...snapshot.definition, instructions: snapshot.instructions,
                    compact: { marker: 'COMPACT', redLines: [], ...snapshot.definition.compact, rawContent: snapshot.compactInstructions } } : definition);
            }
            return skills;
        });
    });
}

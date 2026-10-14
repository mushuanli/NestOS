import { assertEffectGrant } from '@itookit/durable-kernel';
import type { ISkillService, SkillLoadResult } from '@itookit/tools/contracts';
import type { EffectAdapter, EffectExecutionContext, EffectReconcileResult } from '@itookit/durable-kernel';
import { resolveCapability, type CapabilitySource } from '../ports/capabilities';
import { rollbackFailedLoad } from '../skill/loaded-state';
import { InFlightEffects } from './in-flight';

export interface SkillLoadEffectRequest { resourceHandleId: string; skillId: string; }

export class SkillLoadEffectAdapter implements EffectAdapter<SkillLoadEffectRequest, SkillLoadResult> {
    readonly kind = 'skill.load';
    readonly version = '1';
    private readonly inFlight = new InFlightEffects();

    constructor(
        private readonly service: CapabilitySource<ISkillService>,
        private readonly onLoaded?: (
            result: SkillLoadResult,
            context: EffectExecutionContext,
        ) => void | Promise<void>,
    ) {}

    async execute(request: SkillLoadEffectRequest, context: EffectExecutionContext): Promise<SkillLoadResult> {
        return this.inFlight.track(context, this.run(request, context));
    }

    /** The Skill mutation is local; confirmation means the in-flight call has settled. */
    async cancel(_request: SkillLoadEffectRequest, context: EffectExecutionContext): Promise<void> {
        await this.inFlight.confirmStopped(context);
    }

    private async run(request: SkillLoadEffectRequest, context: EffectExecutionContext): Promise<SkillLoadResult> {
        assertEffectGrant(context, request.resourceHandleId, 'skill');
        if (!request.skillId.trim()) throw new Error('Skill id is required');
        const service = await resolveCapability(this.service, context);
        if (service.getSkill(request.skillId)?.disableModelInvocation) {
            throw new Error(`Skill "${request.skillId}" cannot be loaded by the model`);
        }
        const wasLoaded = service.getLoadedSkills().some(item => item.id === request.skillId);
        const result = await service.loadSkill(request.skillId);
        if (!result.success) throw new Error(result.error ?? `Skill failed to load: ${request.skillId}`);
        try {
            await this.onLoaded?.(result, context);
        } catch (error) {
            // A failed identity write must not leave a Skill live that this call loaded.
            if (!wasLoaded) await rollbackFailedLoad(service, request.skillId, error);
            throw error;
        }
        return result;
    }

    async reconcile(): Promise<EffectReconcileResult<SkillLoadResult>> {
        return { status: 'retry' };
    }
}

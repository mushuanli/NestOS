import { createContextAssembler, type IContextAssembler, type ContextSnapshot } from '@itookit/llm-context';
import type { ConversationExecution, ConversationRunCoordinatorOptions } from './conversation-run-coordinator';
import type { ResolvedDirectAgentPolicy } from '../contracts/direct-agent-policy';
import { ContextProfileStore } from '../persistence/context-profile-store';
import { directExecutionMode } from './direct-execution-mode';

export interface ConversationLocation { branchRef: string; branchHead: string | null; }
type ContextOptions = Pick<ConversationRunCoordinatorOptions, 'engine' | 'loadArtifact' | 'retrieveMemory' | 'resolveSessionContext'>;

/** Session history selection and host materials are assembled before task construction. */
export class ConversationContextBuilder {
    constructor(private readonly options: ContextOptions, private readonly policy: ResolvedDirectAgentPolicy) {}

    async resolveLocation(
        execution: ConversationExecution,
    ): Promise<ConversationLocation> {
        const manifest = await execution.log.loadManifest();
        const branchRef = execution.task.frozen?.branchRef
            ?? manifest.currentBranch
            ?? 'main';
        const branchHead = execution.task.frozen?.branchHead
            ?? manifest.branches[branchRef]
            ?? null;
        return { branchRef, branchHead };
    }

    async assemble(
        execution: ConversationExecution,
        location: ConversationLocation,
        skillsPrompt?: string,
        includeMemory = true,
    ): Promise<ContextSnapshot> {
        const manifest = await execution.log.loadManifest();
        const profile = manifest.branchMeta[location.branchRef]?.contextProfile
            ?? { id: '', revision: 0 };
        const assembler = this.contextAssembler(execution, includeMemory);
        const version = execution.task.frozen?.agentVersion
            ?? execution.config.agentVersion
            ?? 'unversioned';
        const sessionContext = await this.options.resolveSessionContext?.(execution.task.sessionId, execution.task.input.text);
        const result = await assembler.assemble(contextPlan(execution, location, profile), execution.task.id, {
            id: execution.config.id,
            version,
        }, this.systemPrompt(execution), skillsPrompt, { persist: false, ...sessionContext });
        return result.snapshot;
    }

    private systemPrompt(execution: ConversationExecution): string[] {
        const base = execution.config.systemPrompt ?? [];
        const prompts = typeof base === 'string' ? [base] : base;
        return directExecutionMode(execution.task.input) === 'agent' ? [...this.policy.systemPrompt, ...prompts] : prompts;
    }

    private contextAssembler(
        execution: ConversationExecution,
        includeMemory = true,
    ): IContextAssembler {
        return createContextAssembler({
            log: execution.log,
            profileStore: new ContextProfileStore(this.options.engine, execution.task.sessionId),
            readRound: roundId => execution.log.readRound(roundId),
            loadArtifact: id => this.options.loadArtifact(id),
            retrieveMemory: includeMemory && this.options.retrieveMemory ? (plan, agent) => this.options.retrieveMemory!(plan, agent, {
                sessionId: execution.task.sessionId, policy: structuredClone(execution.config.memoryPolicy),
            }) : undefined,
        });
    }

}

function contextPlan(
    execution: ConversationExecution,
    location: ConversationLocation,
    profile: { id: string; revision: number },
) {
    return {
        branchRef: location.branchRef,
        branchHead: location.branchHead,
        profile,
        // The assembler de-duplicates this against the Round that owns it, so a
        // Round excluded by context policy can never drop the prompt entirely.
        pendingUserMessage: { role: 'user' as const, content: execution.task.input.text },
        pendingRoundId: execution.roundId,
        explicitInputs: [],
        tokenBudget: execution.config.defaultContextPolicy?.tokenBudget,
    };
}

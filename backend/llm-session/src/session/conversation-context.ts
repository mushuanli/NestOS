import { createContextAssembler, type IContextAssembler, type ContextSnapshot } from '@itookit/llm-context';
import type {DirectConversationInput} from './direct-conversation';
import type {ExecutionTask, ChatAttachment} from '../core/types';
import type {RoundLog} from '../persistence/round-log';
import type {ISessionRepository} from '../persistence/types';
import type {Artifact} from '@itookit/llm-flow/contracts';
import type {ContextPlan, RetrievedMemoryEntry} from '@itookit/llm-context';
import type {MemoryPolicy} from '@itookit/llm-tasks/contracts';
import type { ResolvedDirectAgentPolicy } from '../contracts/direct-agent-policy';
import { ContextProfileStore } from '../persistence/context-profile-store';
import { directExecutionMode } from './direct-execution-mode';
import type {RoundManifest} from '../persistence/round-types';
import {conversationUserMessage, materializeAttachmentMessage, materializeHarnessMessage} from './conversation-attachments';

export interface ConversationLocation { branchRef: string; branchHead: string | null; }
export interface ConversationContextInput extends DirectConversationInput {
    task: Pick<ExecutionTask, 'id' | 'sessionId' | 'input' | 'frozen'>;
    log: RoundLog;
    contextFiles: ChatAttachment[];
}
export interface ConversationContextOptions {
    engine: ISessionRepository;
    loadArtifact(sessionId: string, id: string): Promise<Artifact | null>;
    resolveSessionContext?(sessionId: string, userMessage: string): Promise<{projectInstructions: string; skillInstructions: string; skillIndex: string}>;
    retrieveMemory?(plan: ContextPlan, agent: {id: string; version: string},
        context: {sessionId: string; policy?: MemoryPolicy}): Promise<RetrievedMemoryEntry[]>;
}

/** Session history selection and host materials are assembled before task construction. */
export class ConversationContextBuilder {
    constructor(private readonly options: ConversationContextOptions, private readonly policy: ResolvedDirectAgentPolicy) {}

    async resolveLocation(
        execution: ConversationContextInput,
    ): Promise<ConversationLocation> {
        const manifest = await execution.log.loadManifest();
        const branchRef = execution.task.frozen?.branchRef
            ?? manifest.currentBranch
            ?? 'main';
        const branchHead = execution.task.frozen ? execution.task.frozen.branchHead : manifest.branches[branchRef] ?? null;
        return { branchRef, branchHead };
    }

    async assemble(
        execution: ConversationContextInput,
        location: ConversationLocation,
        skillsPrompt?: string,
        includeMemory = true,
    ): Promise<ContextSnapshot> {
        const manifest = await execution.log.loadManifest();
        const profile = (execution.task.frozen ? execution.task.frozen.contextProfile : manifest.branchMeta[location.branchRef]?.contextProfile)
            ?? { id: '', revision: 0 };
        const version = execution.config.target?.version ?? execution.task.frozen?.agentVersion
            ?? execution.config.agentVersion
            ?? 'unversioned';
        const sessionContext = await this.options.resolveSessionContext?.(execution.task.sessionId, execution.task.input.text);
        const pending = await this.currentMessage(execution);
        const assembler = this.contextAssembler(execution, location.branchRef, manifest, includeMemory, pending);
        const plan = contextPlan(execution, location, profile, pending);
        const seed = (await this.options.engine.getManifest(execution.task.sessionId)).initialContext;
        if (seed) plan.explicitInputs.push({ kind: 'text', content: typeof seed.value === 'string' ? seed.value : JSON.stringify(seed.value), label: 'Initial conversation material', order: 0 });
        const result = await assembler.assemble(plan, execution.task.id, {
            id: execution.config.id,
            version,
        }, this.systemPrompt(execution), skillsPrompt, { persist: false, ...sessionContext });
        return result.snapshot;
    }

    private systemPrompt(execution: ConversationContextInput): string[] {
        const base = execution.config.systemPrompt ?? [];
        const prompts = typeof base === 'string' ? [base] : base;
        return directExecutionMode(execution.task.input) === 'agent' ? [...this.policy.systemPrompt, ...prompts] : prompts;
    }

    private async currentMessage(execution: ConversationContextInput) {
        const pending = conversationUserMessage(execution.task.input.text, execution.contextFiles);
        if (execution.config.execution?.kind === 'harness')
            execution.currentInput = await materializeHarnessMessage(this.options.engine, execution.task.sessionId, pending);
        return pending;
    }

    private contextAssembler(
        execution: ConversationContextInput,
        branchRef: string,
        manifest: RoundManifest,
        includeMemory = true,
        pending?: import('@itookit/llm-context').ChatMessage,
    ): IContextAssembler {
        const resolved = new Map<import('@itookit/llm-context').ChatMessage, Promise<import('@itookit/llm-context').ChatMessage>>();
        if (pending && execution.currentInput) resolved.set(pending, Promise.resolve(execution.currentInput));
        const materialize = execution.config.execution?.kind === 'harness' ? materializeHarnessMessage : materializeAttachmentMessage;
        return createContextAssembler({
            log: execution.log,
            profileStore: new ContextProfileStore(this.options.engine, execution.task.sessionId),
            readRound: roundId => execution.log.readRound(roundId, branchRef, manifest),
            resolveMessage: message => {
                if (!resolved.has(message)) resolved.set(message, materialize(this.options.engine, execution.task.sessionId, message));
                return resolved.get(message)!;
            },
            loadArtifact: id => this.options.loadArtifact(execution.task.sessionId, id),
            retrieveMemory: includeMemory && this.options.retrieveMemory ? (plan, agent) => this.options.retrieveMemory!(plan, agent, {
                sessionId: execution.task.sessionId, policy: structuredClone(execution.config.memoryPolicy),
            }) : undefined,
        });
    }

}

function contextPlan(
    execution: ConversationContextInput,
    location: ConversationLocation,
    profile: { id: string; revision: number },
    pendingUserMessage: import('@itookit/llm-context').ChatMessage,
) {
    return {
        branchRef: location.branchRef,
        branchHead: location.branchHead,
        profile,
        // The assembler de-duplicates this against the Round that owns it, so a
        // Round excluded by context policy can never drop the prompt entirely.
        pendingUserMessage,
        pendingRoundId: execution.roundId,
        explicitInputs: [] as import('@itookit/llm-context').InputBinding[],
        tokenBudget: execution.config.defaultContextPolicy?.tokenBudget,
    };
}

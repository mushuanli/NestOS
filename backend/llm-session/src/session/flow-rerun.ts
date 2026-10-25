import { FlowDefinitionStore, flowRevisionDigest, validateFlowParameters, hasValidationErrors, type FlowStore } from '@itookit/llm-flow';
import type { DagPluginCatalog, FlowDraft, FlowRevision, JsonValue } from '@itookit/llm-flow/contracts';
import type { Round } from '../contracts';
import { RoundLog } from '../persistence/round-log';
import { ulid } from '../persistence/ulid';
import type { SessionRegistry } from './session-registry';
import type { SessionRunCoordinator } from './session-run-coordinator';

/** A rerun creates a replacement branch; it never edits a previous invocation. */
export class FlowRerunService {
    private pending = false;
    constructor(private registry: SessionRegistry, private runs: SessionRunCoordinator, private store: FlowStore, private plugins?: DagPluginCatalog) {}

    async context(sourceRoundId?: string | null) {
        const { sessionId } = this.registry.ensureBound();
        const log = new RoundLog(this.registry.engine, sessionId);
        const manifest = await log.loadManifest();
        const sessionFlow = (await this.registry.engine.getManifest(sessionId))?.flow;
        const ids = new Set([manifest.rootRoundId, ...Object.values(manifest.branches),
            ...Object.keys(manifest.children), ...Object.values(manifest.children).flat()].filter((id): id is string => !!id));
        const rounds = (await Promise.all([...ids].map(id => log.readRound(id))))
            .filter((round): round is NonNullable<typeof round> => !!round && !round._deleted && !!round.flow)
            .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        const source = sourceRoundId ? rounds.find(round => round.id === sourceRoundId)
            : rounds.find(round => !sessionFlow || round.flow?.flowId === sessionFlow.flowId);
        if (sourceRoundId && !source) throw new Error('Flow source Round is unavailable');
        const flow = source?.flow ?? sessionFlow;
        if (!flow) return null;
        const definitions = new FlowDefinitionStore(this.store, this.plugins);
        const immutableTarget = source?.target?.kind === 'flow' || source?.target?.kind === 'agent' && !!await this.runs.publishedAgentTarget(source.target);
        const draft = immutableTarget ? undefined : await definitions.loadDraft(flow.flowId);
        const definition = draft ?? await definitions.loadRevision(flow.flowId, immutableTarget ? flow.revision : undefined);
        if (!definition) throw new Error(`Flow definition not found: ${flow.flowId}`);
        return { sessionId, sourceRoundId: source?.id ?? null, flow, definition, draft, immutableTarget,
            ...(sourceRoundId ? {sourceSelection: 'selected' as const} : {}),
            definitionKey: definitionKey(definition), agentId: source?.target?.kind === 'flow' ? '' : source?.agentId ?? 'default', target: source?.target };
    }

    async run(parameters: Record<string, JsonValue>, sourceRoundId: string | null, expectedDefinitionKey?: string, connectionId?: string, connectionBindings?: Record<string, string>, sourceSelection?: 'selected') {
        if (sourceSelection !== undefined && (sourceSelection !== 'selected' || !sourceRoundId)) throw new Error('Invalid Flow source selection');
        if (this.pending) throw new Error('Flow rerun is already being submitted');
        this.pending = true;
        try { return await this.submit(parameters, sourceRoundId, expectedDefinitionKey, connectionId, connectionBindings, sourceSelection); }
        finally { this.pending = false; }
    }

    private async submit(parameters: Record<string, JsonValue>, sourceRoundId: string | null, expectedDefinitionKey?: string, connectionId?: string, connectionBindings?: Record<string, string>, sourceSelection?: 'selected') {
        this.registry.ensureNotGenerating('rerun flow');
        const context = await this.context(sourceSelection === 'selected' ? sourceRoundId : undefined);
        if (!context || context.sourceRoundId !== sourceRoundId) throw new Error('Session flow changed; reopen the rerun form');
        if (expectedDefinitionKey && expectedDefinitionKey !== context.definitionKey) throw new Error('Flow changed; reopen the rerun form');
        const issues = validateFlowParameters(context.definition.parameters, parameters, context.definition.inputGroups);
        if (hasValidationErrors(issues)) throw new Error(issues.map(issue => issue.message).join('; '));
        this.registry.ensureNotGenerating('rerun flow');
        const { sessionId, state, runtime } = this.registry.ensureBound();
        if (sessionId !== context.sessionId) throw new Error('Session changed; reopen the rerun form');
        await this.runs.assertCanSubmit(sessionId, true);
        if (this.registry.ensureBound().sessionId !== sessionId) throw new Error('Session changed; reopen the rerun form');
        this.registry.ensureNotGenerating('rerun flow');
        const definitions = new FlowDefinitionStore(this.store, this.plugins);
        const latest = await definitions.loadRevision(context.flow.flowId, context.immutableTarget ? context.flow.revision : undefined);
        const definition = context.draft && (!latest || definitionKey(latest) !== context.definitionKey)
            ? await definitions.createRevision(context.draft) : latest ?? context.definition as FlowRevision;
        if (this.registry.ensureBound().sessionId !== sessionId) throw new Error('Session changed; reopen the rerun form');
        this.registry.ensureNotGenerating('rerun flow');
        return this.launch({ ...context, definition }, parameters, { sessionId, state, runtime }, connectionId, connectionBindings);
    }

    private async launch(context: NonNullable<Awaited<ReturnType<FlowRerunService['context']>>> & { definition: FlowRevision },
        parameters: Record<string, JsonValue>, bound: ReturnType<SessionRegistry['ensureBound']>, connectionId?: string, connectionBindings?: Record<string, string>) {
        const { sessionId, state, runtime } = bound;
        const log = new RoundLog(this.registry.engine, sessionId), roundId = ulid();
        const source = context.sourceRoundId ? await log.readRound(context.sourceRoundId) : undefined;
        const invocation = await this.runs.rerunInvocation(sessionId, source ?? undefined);
        const previous = await log.loadManifest();
        const branch = await log.createBranchForReplacement(null, roundId, { createdFrom: 'regenerate' });
        const flow: NonNullable<Round['flow']> = { flowId: context.definition.id, revision: context.definition.revision, parameters, ...(connectionBindings ? { connectionBindings } : {}) };
        const originalInput = (context.flow as NonNullable<Round['flow']>).input;
        try {
            await this.registry.reloadSessionData(sessionId, state);
            this.switched(sessionId, branch.branchName, branch.commonHeadId ?? '', roundId);
            const taskId = await this.runs.submit({ sessionId, text: originalInput?.prompt ?? `${context.definition.name} · ${context.definition.id}@v${context.definition.revision}\n\n${JSON.stringify(parameters, null, 2)}`,
                files: [], agentId: context.target?.kind === 'flow' ? '' : context.agentId, invocation,
                ...(context.target?.kind === 'flow' ? {target: {kind: 'flow' as const, id: context.definition.id, version: String(context.definition.revision)},
                    source: {kind: 'arguments' as const, value: structuredClone(parameters)}} : context.immutableTarget && context.target ? {
                    target: {kind: 'agent' as const, id: context.target.id, version: context.target.version}, expectedTarget: context.target,
                    source: {kind: 'arguments' as const, value: structuredClone(parameters)}} : {}),
                overrides: context.immutableTarget ? {...(connectionId ? {connectionId} : {}),
                    flowExpectedSignature: {id: context.definition.id, revision: context.definition.revision, digest: context.definition.digest}}
                    : connectionId ? {connectionId} : undefined, roundTarget: {mode: 'append-new', roundId},
                sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'flow', ...flow } },
            }, runtime);
            return { taskId, branchName: branch.branchName };
        } catch (error) {
            const current = await log.loadManifest();
            if (current.currentBranch === branch.branchName && current.currentHead === (branch.commonHeadId ?? null)) {
                delete current.branches[branch.branchName]; delete current.branchMeta[branch.branchName];
                current.currentBranch = previous.currentBranch; current.currentHead = current.branches[previous.currentBranch] ?? null;
                await log.saveManifest(current);
                await this.registry.reloadSessionData(sessionId, state);
                this.switched(sessionId, current.currentBranch, current.currentHead ?? '');
            }
            throw error;
        }
    }

    private switched(sessionId: string, branchName: string, headRoundId: string, branchRootRoundId?: string): void {
        this.registry.eventBus.emitSession(sessionId, { type: 'branch:switched', payload: {
            branchName, headRoundId, branchRootRoundId, reason: branchRootRoundId ? 'regenerate' : 'manual-switch', displayPosition: 'top',
        } });
    }
}

function definitionKey(definition: FlowDraft | FlowRevision): string {
    return flowRevisionDigest(definitionSnapshot(definition));
}

function definitionSnapshot(definition: FlowDraft | FlowRevision): FlowRevision {
    return { ...definition, dependencyLocks: undefined, connections: definition.connections ?? [], parameters: definition.parameters ?? [], functions: definition.functions?.map(definitionSnapshot),
        revision: 0, createdAt: 0, digest: '' };
}

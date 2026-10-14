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

    async context() {
        const { sessionId } = this.registry.ensureBound();
        const log = new RoundLog(this.registry.engine, sessionId);
        const manifest = await log.loadManifest();
        const sessionFlow = (await this.registry.engine.getManifest(sessionId))?.flow;
        const ids = new Set([manifest.rootRoundId, ...Object.values(manifest.branches),
            ...Object.keys(manifest.children), ...Object.values(manifest.children).flat()].filter((id): id is string => !!id));
        const rounds = (await Promise.all([...ids].map(id => log.readRound(id))))
            .filter((round): round is NonNullable<typeof round> => !!round && !round._deleted && !!round.flow)
            .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        const source = rounds.find(round => !sessionFlow || round.flow?.flowId === sessionFlow.flowId);
        const flow = source?.flow ?? sessionFlow;
        if (!flow) return null;
        const definitions = new FlowDefinitionStore(this.store, this.plugins);
        const draft = await definitions.loadDraft(flow.flowId);
        const definition = draft ?? await definitions.loadRevision(flow.flowId);
        if (!definition) throw new Error(`Flow definition not found: ${flow.flowId}`);
        return { sessionId, sourceRoundId: source?.id ?? null, flow, definition, draft,
            definitionKey: definitionKey(definition), agentId: source?.agentId ?? 'default' };
    }

    async run(parameters: Record<string, JsonValue>, sourceRoundId: string | null, expectedDefinitionKey?: string, connectionId?: string) {
        if (this.pending) throw new Error('Flow rerun is already being submitted');
        this.pending = true;
        try { return await this.submit(parameters, sourceRoundId, expectedDefinitionKey, connectionId); }
        finally { this.pending = false; }
    }

    private async submit(parameters: Record<string, JsonValue>, sourceRoundId: string | null, expectedDefinitionKey?: string, connectionId?: string) {
        this.registry.ensureNotGenerating('rerun flow');
        const context = await this.context();
        if (!context || context.sourceRoundId !== sourceRoundId) throw new Error('Session flow changed; reopen the rerun form');
        if (expectedDefinitionKey && expectedDefinitionKey !== context.definitionKey) throw new Error('Flow changed; reopen the rerun form');
        const issues = validateFlowParameters(context.definition.parameters, parameters);
        if (hasValidationErrors(issues)) throw new Error(issues.map(issue => issue.message).join('; '));
        this.registry.ensureNotGenerating('rerun flow');
        const { sessionId, state, runtime } = this.registry.ensureBound();
        if (sessionId !== context.sessionId) throw new Error('Session changed; reopen the rerun form');
        await this.runs.assertCanSubmit(sessionId, true);
        if (this.registry.ensureBound().sessionId !== sessionId) throw new Error('Session changed; reopen the rerun form');
        this.registry.ensureNotGenerating('rerun flow');
        const definitions = new FlowDefinitionStore(this.store, this.plugins);
        const latest = await definitions.loadRevision(context.flow.flowId);
        const definition = context.draft && (!latest || definitionKey(latest) !== context.definitionKey)
            ? await definitions.createRevision(context.draft) : latest ?? context.definition as FlowRevision;
        if (this.registry.ensureBound().sessionId !== sessionId) throw new Error('Session changed; reopen the rerun form');
        this.registry.ensureNotGenerating('rerun flow');
        return this.launch({ ...context, definition }, parameters, { sessionId, state, runtime }, connectionId);
    }

    private async launch(context: NonNullable<Awaited<ReturnType<FlowRerunService['context']>>> & { definition: FlowRevision },
        parameters: Record<string, JsonValue>, bound: ReturnType<SessionRegistry['ensureBound']>, connectionId?: string) {
        const { sessionId, state, runtime } = bound;
        const log = new RoundLog(this.registry.engine, sessionId), roundId = ulid();
        const previous = await log.loadManifest();
        const branch = await log.createBranchForReplacement(null, roundId, { createdFrom: 'regenerate' });
        const flow: NonNullable<Round['flow']> = { flowId: context.definition.id, revision: context.definition.revision, parameters };
        try {
            await this.registry.reloadSessionData(sessionId, state);
            this.switched(sessionId, branch.branchName, branch.commonHeadId ?? '', roundId);
            const taskId = await this.runs.submit({ sessionId, text: `${context.definition.name} · ${context.definition.id}@v${context.definition.revision}\n\n${JSON.stringify(parameters, null, 2)}`,
                files: [], agentId: context.agentId, overrides: connectionId ? { connectionId } : undefined, roundTarget: { mode: 'append-new', roundId },
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
    return flowRevisionDigest({ ...definition, parameters: definition.parameters ?? [], revision: 0, createdAt: 0 });
}

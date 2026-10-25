import {isRootCallable, callableExposure, assertRootCallable, isTargetRef, type DagPluginCatalog, type FlowRevision} from '@itookit/llm-flow/contracts';
import {checkFlowSyntax, type FlowDefinitionStore} from '@itookit/llm-flow';
import type {AgentDefinition, IAgentConfigService} from '../contracts';
import type {RootCallTarget, RootTargetCatalog} from '../contracts/submission';
import type {SessionHost} from '../utils/host-ports';
import type {AgentResolver} from './agent-resolver';
import {flowTargetRef} from './flow-target';
import {ulid} from '../persistence/ulid';
import {publishedAgentDefinition} from '../services/agent-definition-digest';

/** Read published root choices without creating sessions, executing programs or acquiring native writers. */
export class RootTargetDirectory {
    constructor(private readonly agents: IAgentConfigService, private readonly resolver: AgentResolver,
        private readonly definitions: Pick<FlowDefinitionStore, 'listDrafts' | 'loadRevision'>,
        private readonly host: SessionHost, private readonly plugins?: DagPluginCatalog) {}

    async list(): Promise<RootTargetCatalog> {
        const result: RootTargetCatalog = {entries: [], issues: []}, operationId = ulid(), started = Date.now();
        const sources = await Promise.allSettled([this.agents.getAgents(), this.definitions.listDrafts()]);
        const [agents, flows] = sources;
        if (agents.status === 'fulfilled') for (const agent of agents.value) await this.append(result, 'agent', agent.id, () => this.agent(agent));
        else result.issues.push({kind: 'agent', code: errorCode(agents.reason, 'CALL_TARGET_CATALOG_READ_FAILED')});
        if (flows.status === 'fulfilled') for (const flow of flows.value) await this.append(result, 'flow', flow.id, () => this.flow(flow.id));
        else result.issues.push({kind: 'flow', code: errorCode(flows.reason, 'CALL_TARGET_CATALOG_READ_FAILED')});
        this.host.logger.info('Call target catalog read', {operation: 'call.targets.list', operationId, stage: 'metadata',
            result: result.issues.length ? 'partial' : 'success', entryCount: result.entries.length, issues: result.issues,
            durationMs: Date.now() - started});
        return result;
    }

    private async append(result: RootTargetCatalog, kind: 'agent' | 'flow', id: string,
        read: () => Promise<RootCallTarget | undefined>): Promise<void> {
        try {const entry = await read(); if (entry) result.entries.push(entry);}
        catch (error) {
            result.issues.push({kind, id, code: errorCode(error, 'CALL_TARGET_INVALID')});
        }
    }

    private async agent(agent: AgentDefinition): Promise<RootCallTarget | undefined> {
        const revision = await this.agents.getAgentRevision?.(agent.id);
        if (revision) agent = publishedAgentDefinition(revision);
        callableExposure(agent.exposure);
        if (!isRootCallable(agent)) return;
        if (agent.availability?.status === 'disabled') throw invalid('CALL_TARGET_DISABLED');
        const input = agent.execution?.kind === 'flow' ? await this.published(agent.execution.flowId, agent.execution.revision) : undefined;
        const target = revision?.target ?? await this.resolver.describeTarget(agent);
        if (!isTargetRef(target) || typeof agent.name !== 'string' || !agent.name.trim()) throw invalid('CALL_TARGET_INVALID');
        return {target, name: agent.name, icon: agent.icon,
            description: agent.description, ...(input ? {input: inputMetadata(input)} : {})};
    }

    private async flow(id: string): Promise<RootCallTarget | undefined> {
        const flow = await this.definitions.loadRevision(id);
        if (!flow) return;
        callableExposure(flow.exposure);
        if (!isRootCallable(flow)) return;
        const published = await this.published(id, flow.revision), target = flowTargetRef(published);
        if (!isTargetRef(target)) throw invalid('CALL_TARGET_INVALID');
        return {target, name: published.name, input: inputMetadata(published)};
    }

    private async published(id: string, revision?: number): Promise<FlowRevision> {
        const flow = await this.definitions.loadRevision(id, revision);
        if (!flow) throw invalid('CALL_TARGET_UNAVAILABLE');
        assertRootCallable(flow);
        if (!checkFlowSyntax(flow, {plugins: this.plugins}).valid) throw invalid('CALL_TARGET_SCHEMA_INVALID');
        return flow;
    }
}

function inputMetadata(flow: FlowRevision): NonNullable<RootCallTarget['input']> {
    return {flowId: flow.id, revision: flow.revision, digest: flow.digest, parameters: structuredClone(flow.parameters ?? [])};
}
function invalid(code: string): Error {return Object.assign(new Error('Published call target is unavailable'), {code});}
function errorCode(error: unknown, fallback: string): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : fallback;
}

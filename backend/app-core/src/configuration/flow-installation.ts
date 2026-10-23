import {createModuleLogger, randomUUID} from '@itookit/common';
import {FlowCommand, collectFlowToolDependencies, flowParameterValues, type FlowDraft, type FlowRevision, type FlowToolDependency} from '@itookit/llm-flow/contracts';
import {checkFlowSource, externalFlowReferences, validateFlowParameters} from '@itookit/llm-flow';
import {SessionCommand, type ICommandBus} from '@itookit/llm-session/contracts';
import type {FlowConfigurationIssue, FlowInstallationReport, FlowInstallations} from '@itookit/app-contracts/services';
import {FlowToolPackages} from './flow-tool-packages';

const log = createModuleLogger('flow-installation');
const codeOf = (error: unknown): string => typeof (error as {code?: unknown})?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test((error as {code: string}).code)
    ? (error as {code: string}).code : 'FLOW_INSTALLATION_FAILED';
const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'Flow installation check failed';

/** One dependency and configuration check shared by import, recovery and explicit installation. */
export class FlowInstallationService implements FlowInstallations {
    private readonly pending = new Map<string, Promise<FlowInstallationReport>>();
    constructor(private readonly commands: ICommandBus, readonly toolPackages: FlowToolPackages) {}
    async list(): Promise<FlowInstallationReport[]> {
        const drafts = await this.commands.execute<FlowDraft[]>(FlowCommand.DraftList, {});
        return Promise.all(drafts.map(flow => this.check(flow.id)));
    }
    async close(): Promise<void> {await Promise.allSettled([...this.pending.values()]);}
    check(flowId: string): Promise<FlowInstallationReport> {return this.prepare(flowId, false);}
    ensure(flowId: string): Promise<FlowInstallationReport> {
        const existing = this.pending.get(flowId); if (existing) return existing;
        const work = this.prepare(flowId, true).finally(() => {if (this.pending.get(flowId) === work) this.pending.delete(flowId);});
        this.pending.set(flowId, work); return work;
    }
    private async prepare(flowId: string, ensure: boolean): Promise<FlowInstallationReport> {
        const operationId = randomUUID(), started = performance.now(), report: FlowInstallationReport = {flowId, status: 'failed', tools: [], parameters: [], connections: [], errors: []};
        let stage = 'definition';
        log.info('flow.install.started', {operation: 'flow.install', operationId, stage, ensure});
        try {
            const source = await this.load(flowId); report.name = source.name; if ('revision' in source) report.revision = source.revision;
            stage = 'schema';
            const checked = await checkFlowSource(source, {resolveComposite: (id, revision) => this.revision(id, revision)});
            if (!checked.valid || !checked.flow) {report.errors = checked.diagnostics.filter(issue => issue.severity !== 'warning'); return report;}
            stage = 'tools'; const dependencies = await this.dependencies(source);
            report.tools = ensure ? (await this.toolPackages.ensure(dependencies)).tools : dependencies.map(item => this.toolPackages.inspect(item));
            stage = 'parameters'; report.parameters = parameterIssues(checked.flow);
            stage = 'connections'; report.connections = await this.connectionIssues(checked.flow, !report.parameters.length);
            report.status = report.tools.some(item => item.status === 'failed') ? 'failed' : report.tools.some(item => item.status === 'missing') ? 'missingTools'
                : report.parameters.length || report.connections.length ? 'needsConfiguration' : 'ready';
            return report;
        } catch (error) {report.errors.push({code: codeOf(error), message: messageOf(error)}); return report;}
        finally {log.info('flow.install.completed', {operation: 'flow.install', operationId, stage, outcome: report.status,
            toolCount: report.tools.length, parameterIssues: report.parameters.length, connectionIssues: report.connections.length,
            toolFailures: report.tools.filter(item => item.status !== 'ready').map(item => ({id: item.id, status: item.status, code: item.code})),
            errorCodes: [...new Set([...report.errors, ...report.parameters, ...report.connections].map(issue => issue.code))], durationMs: Math.round(performance.now() - started)});}
    }
    private async load(id: string): Promise<FlowDraft | FlowRevision> {
        if (typeof id !== 'string' || !id.trim()) throw Object.assign(new Error('Flow identity is required'), {code: 'FLOW_ID_REQUIRED'});
        const draft = await this.commands.execute<FlowDraft | null>(FlowCommand.DraftLoad, {id});
        if (draft) return draft;
        const published = await this.revision(id); if (published) return published;
        throw Object.assign(new Error('Flow definition is unavailable'), {code: 'FLOW_NOT_FOUND'});
    }
    private revision(id: string, revision?: number): Promise<FlowRevision | null> {
        return this.commands.execute(FlowCommand.RevisionGet, {id, revision});
    }
    private async dependencies(flow: FlowDraft | FlowRevision): Promise<FlowToolDependency[]> {
        const pending = [flow], visited = new Set<string>(), dependencies = new Map<string, FlowToolDependency>();
        for (const current of pending) {
            if (visited.size >= 1000) throw Object.assign(new Error('Flow dependency limit exceeded'), {code: 'FLOW_DEPENDENCY_LIMIT'});
            const key = JSON.stringify([current.id, 'revision' in current ? current.revision : current.draftVersion]);
            if (visited.has(key)) continue; visited.add(key);
            for (const item of collectFlowToolDependencies(current)) {
                const previous = dependencies.get(item.id);
                if (previous?.version && item.version && previous.version !== item.version) throw Object.assign(new Error('Flow tool dependency versions conflict'), {code: 'FLOW_TOOL_VERSION_CONFLICT'});
                dependencies.set(item.id, {...item, ...(item.version ?? previous?.version ? {version: item.version ?? previous?.version} : {})});
            }
            for (const reference of externalFlowReferences(current)) {
                const child = await this.revision(reference.flowId, reference.revision);
                if (!child) throw Object.assign(new Error('Referenced Flow is unavailable'), {code: 'FLOW_DEPENDENCY_MISSING'});
                pending.push(child);
            }
        }
        return [...dependencies.values()];
    }
    private async connectionIssues(flow: FlowRevision, checkGraph: boolean): Promise<FlowConfigurationIssue[]> {
        const values = flowParameterValues(flow.parameters, undefined, flow.inputGroups), issues: FlowConfigurationIssue[] = [];
        issues.push(...await this.commands.execute<FlowConfigurationIssue[]>(SessionCommand.CheckFlowConnectionSlots, {flow, parameters: values}));
        if (!issues.length && checkGraph) {
            try {await this.commands.execute(SessionCommand.CheckFlowConnections, {flow, parameters: values});}
            catch (error) {issues.push({code: codeOf(error), message: messageOf(error)});}
        }
        return issues;
    }
}

function parameterIssues(flow: FlowRevision): FlowConfigurationIssue[] {
    const issues = validateFlowParameters(flow.parameters, undefined, flow.inputGroups);
    for (const field of flow.parameters ?? []) if (field.default !== undefined) {
        issues.push(...validateFlowParameters([{...field, required: false, onMissing: 'error'}], {[field.name]: field.default}));
    }
    return [...new Map(issues.map(issue => [issue.code + ':' + issue.message, issue])).values()];
}

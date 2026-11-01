/** Dependencies name tools, while trusted host catalogs own packages and executable locations. */
import type {FlowToolDependency} from '@itookit/llm-flow/contracts';
export type {FlowToolDependency} from '@itookit/llm-flow/contracts';
export interface ToolDependencyState extends FlowToolDependency {
    status: 'ready' | 'missing' | 'failed';
    code?: string;
    reason?: string;
}
export interface ToolDependencyResult {tools: ToolDependencyState[]}
export interface ToolRunRecord {
    id: string; toolId: string; version: string; startedAt: number; finishedAt?: number; durationMs?: number;
    status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'; code?: string;
    sessionId?: string; taskId?: string; operationId?: string;
    collection?: import('../digital-twin/scanner').TwinCollectionProgress;
}
export interface ToolPackageInfo {
    runningVersions?: Array<{version: string; count: number}>;
    activationId?: string;
    canUninstall?: boolean;
    canSwitch?: boolean;
    pendingVersion?: string;
    connectionTypes?: string[];
    configurationWarning?: string;
    connectionMethods?: Record<string, Array<'browser' | 'import'>>;
    configuration?: ToolPackageConfiguration;
    guide?: ToolPackageGuide;
    guideError?: string;
    flowCount?: number;
    flowResources?: Array<{id: string; name: string; installed: boolean}>;
    flowResourceError?: string;
    id: string;
    name?: string;
    version: string;
    description?: string;
    tools: FlowToolDependency[];
    status: 'registered' | 'available' | 'missing' | 'failed';
    code?: string;
    reason?: string;
}
export type ToolPackageFlow = import('@itookit/llm-flow/contracts').FlowDraft;
export interface ToolDependencyResolver {
    onChange?(listener: () => void): () => void;
    switchVersion?(id: string, version: string, expectedVersion: string, operationId?: string): Promise<void>;
    configure?(id: string, version: string, settings: ToolPackageSettings): Promise<void>;
    history?(id: string, version: string): Promise<ToolRunRecord[]>;
    uninstall?(id: string, version: string): Promise<void>;
    flowTemplates?(packageId: string, version: string): Promise<ToolPackageFlow[]>;
    ensure(dependencies: readonly FlowToolDependency[]): Promise<ToolDependencyResult>;
    list?(): Promise<ToolPackageInfo[]>;
}
export interface ToolPackages {
    onChange?(listener: () => void): () => void;
    switchVersion?(id: string, version: string, expectedVersion: string, operationId?: string): Promise<void>;
    configure?(id: string, version: string, settings: ToolPackageSettings): Promise<void>;
    history?(id: string, version: string): Promise<ToolRunRecord[]>;
    uninstall?(id: string, version: string): Promise<void>;
    readonly connections?: import('./tool-connections').ToolConnections;
    installFlows?(packageId: string, version: string): Promise<number>;
    list(): Promise<ToolPackageInfo[]>;
    ensure(dependencies: FlowToolDependency[]): Promise<ToolDependencyResult>;
}
export interface FlowConfigurationIssue {code: string; field?: string; message: string}
export type FlowInstallationIssue = FlowConfigurationIssue;
export interface FlowInstallationReport {
    flowId: string;
    name?: string;
    revision?: number;
    status: 'ready' | 'needsConfiguration' | 'missingTools' | 'failed';
    tools: ToolDependencyState[];
    parameters: FlowConfigurationIssue[];
    connections: FlowConfigurationIssue[];
    errors: FlowConfigurationIssue[];
}
export interface FlowInstallations {
    list(): Promise<FlowInstallationReport[]>;
    check(flowId: string): Promise<FlowInstallationReport>;
    ensure(flowId: string): Promise<FlowInstallationReport>;
}

/** Package-authored documentation. Steps are displayed as text and never executed. */
export interface ToolPackageGuide {
    version: 1;
    /** Show these instructions beside personal credential import for the named connection types. */
    connectionTypes?: string[];
    title: string;
    description?: string;
    steps: Array<{title: string; description: string; command?: string; links?: Array<{label: string; url: string}>}>;
}

/** Ordinary defaults only; authentication stays in user-owned ToolConnections. */
export interface ToolPackageSettings {
    enabled: boolean;
    disabledTools?: string[];
    defaults: Record<string, Record<string, import('@itookit/llm-flow/contracts').JsonValue>>;
}
export interface ToolPackageConfiguration extends ToolPackageSettings {
    tools: Array<{id: string; enableWith?: string; label?: string; hidden?: boolean; advanced?: string[]; parameters: import('@itookit/llm-flow/contracts').FlowParameter[]; optionLabels?: Record<string, Record<string, string>>}>;
}

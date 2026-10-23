/** Dependencies name tools, while trusted host catalogs own packages and executable locations. */
import type {FlowToolDependency} from '@itookit/llm-flow/contracts';
export type {FlowToolDependency} from '@itookit/llm-flow/contracts';
export interface ToolDependencyState extends FlowToolDependency {
    status: 'ready' | 'missing' | 'failed';
    code?: string;
    reason?: string;
}
export interface ToolDependencyResult {tools: ToolDependencyState[]}
export interface ToolPackageInfo {
    id: string;
    name?: string;
    version: string;
    description?: string;
    tools: FlowToolDependency[];
    status: 'registered' | 'available' | 'missing' | 'failed';
    code?: string;
    reason?: string;
}
export interface ToolDependencyResolver {
    ensure(dependencies: readonly FlowToolDependency[]): Promise<ToolDependencyResult>;
    list?(): Promise<ToolPackageInfo[]>;
}
export interface ToolPackages {
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

import type { JsonValue, OperationContext, OperationLedger, OperationReceipt, MountedToolbar } from './contracts';

export interface FlowPort { readonly id: string; readonly label: string }
export type FlowField = { readonly id: string; readonly label: string; readonly required?: boolean } & (
    | { readonly kind: 'text' | 'number' | 'boolean' | 'json' }
    | { readonly kind: 'choice'; readonly choices: readonly { readonly id: string; readonly label: string }[] }
);
export interface FlowNodeType {
    readonly id: string; readonly label: string; readonly description?: string;
    readonly fields?: readonly FlowField[];
}
export interface FlowNodeView {
    readonly id: string; readonly revision: number; readonly type: string; readonly name: string;
    readonly config: Readonly<Record<string, JsonValue>>;
    readonly position: { readonly x: number; readonly y: number };
    readonly inputs: readonly FlowPort[]; readonly outputs: readonly FlowPort[];
}
export interface FlowNodeTarget { readonly nodeId: string; readonly expectedRevision: number }
export interface FlowEndpoint { readonly nodeId: string; readonly portId: string }
export interface FlowEdgeView {
    readonly id: string; readonly revision: number; readonly from: FlowEndpoint; readonly to: FlowEndpoint;
    readonly label?: string;
}
export interface FlowExecutionView {
    readonly executionRef: string;
    readonly state: 'running' | 'waiting-input' | 'succeeded' | 'failed' | 'cancelled';
    readonly nodes: Readonly<Record<string, { readonly state: string; readonly output?: JsonValue; readonly error?: string }>>;
    readonly output?: JsonValue;
}
export type FlowActionName = 'addNode' | 'updateNode' | 'removeNode' | 'connect' | 'disconnect' | 'save' | 'run' | 'cancel';
export interface FlowSnapshot {
    readonly flowId: string; readonly viewId: string; readonly revision: number;
    /** Editing version is independent of streaming execution updates. */
    readonly graphRevision: number;
    readonly title: string; readonly nodes: readonly FlowNodeView[]; readonly edges: readonly FlowEdgeView[];
    readonly nodeTypes: readonly FlowNodeType[];
    readonly execution?: FlowExecutionView;
    readonly allowed: readonly FlowActionName[];
    readonly loading: boolean; readonly error?: string;
}
export interface FlowSource {
    getSnapshot(): FlowSnapshot;
    subscribe(listener: () => void): () => void;
    refresh?(): Promise<void>;
}
export interface FlowNodeChange {
    readonly name?: string;
    readonly config?: Readonly<Record<string, JsonValue>>;
    readonly position?: { readonly x: number; readonly y: number };
}
export interface FlowActions {
    addNode?(typeId: string, position: { readonly x: number; readonly y: number }, context: OperationContext): Promise<OperationReceipt>;
    updateNode?(target: FlowNodeTarget, change: FlowNodeChange, context: OperationContext): Promise<OperationReceipt>;
    removeNode?(target: FlowNodeTarget, context: OperationContext): Promise<OperationReceipt>;
    connect?(edge: { readonly from: FlowEndpoint; readonly to: FlowEndpoint; readonly expectedGraphRevision: number }, context: OperationContext): Promise<OperationReceipt>;
    disconnect?(target: { readonly edgeId: string; readonly expectedRevision: number }, context: OperationContext): Promise<OperationReceipt>;
    save?(expectedGraphRevision: number, context: OperationContext): Promise<OperationReceipt>;
    run?(expectedGraphRevision: number, context: OperationContext): Promise<OperationReceipt>;
    cancel?(executionRef: string, context: OperationContext): Promise<OperationReceipt>;
    reconcile?(operationId: string): Promise<OperationReceipt>;
}
export interface FlowInspectorContext {
    readonly node: FlowNodeView;
    readonly snapshot: FlowSnapshot;
    readonly canEdit: boolean;
    /** Applies the node revision captured when this inspector was mounted. */
    readonly commit: (change: FlowNodeChange) => Promise<void>;
}
export interface MountedFlowInspector { destroy(): void | Promise<void> }
export interface FlowOptions {
    readonly source: FlowSource;
    readonly actions: FlowActions;
    readonly operations: OperationLedger;
    readonly mountInspector?: (container: HTMLElement, context: FlowInspectorContext) => MountedFlowInspector;
    readonly mountToolbar?: (container: HTMLElement, snapshot: FlowSnapshot) => Pick<MountedToolbar, 'destroy'>;
    readonly translate?: (key: string) => string;
    readonly locale?: 'zh-CN' | 'en';
    readonly onError?: (error: unknown) => void;
}
export interface FlowView {
    setActive(active: boolean): void;
    selectNode(id: string): void;
    reconcile(operationId: string): Promise<void>;
    focus(): void;
    destroy(): Promise<void>;
}

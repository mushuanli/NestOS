/** Read-only assistant attention items; opening an item never approves or runs it. */
export interface AssistantEvent {
    id: string; revision: string; source: 'sessions' | 'scanners';
    kind: 'approval' | 'input' | 'blocked' | 'failure' | 'completion' | 'scanFailure' | 'scanCompletion' | 'scanPaused';
    title: string; at: number; priority: number; requiresAction: boolean;
    target: {target: 'chat' | 'twin'; resourceId: string};
}
export interface AssistantScanner {id: string; name: string; workspaceId: string; workspaceName: string}
export interface AssistantOverview {events: AssistantEvent[]; scanners: AssistantScanner[]; unavailable: Array<'sessions' | 'scanners'>}
/** Small projection for navigation and attention, excluding evidence, prompts and credentials. */
export interface TwinActivitySummary {
    workspace: {id: string; name: string};
    plans: Array<{id: string; name: string}>;
    runs: Array<{id: string; planId: string; name: string; state: string; at: number}>;
}

/** Workspace routing uses resource identities; each workspace defines their meaning. */
export interface WorkspaceController {
    start(): Promise<void>;
    /** Suspend view-only work and flush edits when hidden; keep background execution alive. */
    setVisible?(visible: boolean): void | Promise<void>;
    openResource(id: string): Promise<void>;
    getActiveResourceId(): string | null;
    destroy(): void | Promise<void>;
}

/** Optional capability; not every workspace creates resources. */
export interface WorkspaceCreation {
    createResource(options?: { title?: string; content?: string; parentPath?: string | null; initialInputState?: { text?: string; agentId?: string } }): Promise<string>;
}

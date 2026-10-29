/** User-owned connection configuration. Secrets are accepted on write and never returned. */
export interface ToolConnectionType {
    id: string; name: string; description: string;
    fields: Array<{name: string; label: string; secret?: boolean; required?: boolean; description?: string}>;
}
export interface ToolConnectionInput {id: string; type: string; name: string; values: Record<string, string>}
export interface ToolConnectionView {id: string; type: string; name: string; values: Record<string, string>; configuredSecrets: string[]}
export interface ToolConnections {
    snapshot(): Promise<{types: ToolConnectionType[]; connections: ToolConnectionView[]}>;
    save(input: ToolConnectionInput): Promise<void>;
    remove(id: string): Promise<void>;
}
/** Trusted tool factories receive this handle, bound by the host to one authenticated user. */
export interface ToolConnectionAccess extends ToolConnections {
    register(type: ToolConnectionType): void;
    resolve(id: string, type: string): Promise<Record<string, string>>;
}

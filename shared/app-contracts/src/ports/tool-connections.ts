/** User-owned connection configuration. Secrets are accepted on write and never returned. */
export interface ToolConnectionType {
    authorization?: ToolOAuthDefinition;
    id: string; name: string; description: string;
    fields: Array<{name: string; label: string; secret?: boolean; required?: boolean; description?: string}>;
}
export interface ToolOAuthDefinition {
    kind: 'oauth2'; authorizationEndpoint: string; tokenEndpoint: string; revocationEndpoint?: string;
    clientIdField: string; clientSecretField?: string; refreshTokenField: string;
    permissionGroups: Array<{id: string; label: string; scopes: string[]}>;
    authorizationParameters?: Record<string, string>;
}
export interface ToolAuthorizationView {operationId: string; connectionId: string; status: 'pending' | 'exchanging' | 'authorized' | 'cancelled' | 'expired' | 'failed'; url?: string; expiresAt: number; code?: string}
export interface ToolConnectionInput {id: string; type: string; name: string; values: Record<string, string>}
export interface ToolConnectionView {id: string; type: string; name: string; values: Record<string, string>; configuredSecrets: string[];
    authorization?: {scopes: string[]; connected: boolean; operation?: ToolAuthorizationView}}
export interface ToolConnections {
    beginAuthorization?(id: string, permissionGroups: string[], operationId: string): Promise<ToolAuthorizationView>;
    authorizationStatus?(operationId: string): Promise<ToolAuthorizationView>;
    cancelAuthorization?(operationId: string): Promise<void>;
    revokeAuthorization?(id: string): Promise<void>;
    snapshot(): Promise<{types: ToolConnectionType[]; connections: ToolConnectionView[]; authorizationRedirectUri?: string}>;
    save(input: ToolConnectionInput): Promise<void>;
    remove(id: string): Promise<void>;
}
/** Trusted tool factories receive this handle, bound by the host to one authenticated user. */
export interface ToolConnectionAccess extends ToolConnections {
    completeAuthorization?(callback: {state: string; code?: string; error?: string}): Promise<void>;
    accessToken?(id: string, type: string): Promise<string>;
    close?(): Promise<void>;
    register(type: ToolConnectionType): void;
    resolve(id: string, type: string): Promise<Record<string, string>>;
}

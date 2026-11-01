/** User-owned connection configuration. Secrets are accepted on write and never returned. */
export interface ToolConnectionType {
    application?: ToolOAuthApplicationView;
    authorization?: ToolOAuthDefinition;
    id: string; name: string; description: string;
    fields: Array<{name: string; label: string; secret?: boolean; required?: boolean; description?: string}>;
}
export interface ToolOAuthApplicationInput {type: string; clientId: string; clientSecret?: string; redirectUri: string}
export interface ToolOAuthApplicationView {configured: boolean; canManage: boolean; clientId?: string; hasSecret?: boolean; redirectUri?: string}
export interface ToolOAuthDefinition {
    kind: 'oauth2'; authorizationEndpoint: string; tokenEndpoint: string; revocationEndpoint?: string;
    clientIdField: string; clientSecretField?: string; refreshTokenField: string;
    permissionGroups: Array<{id: string; label: string; scopes: string[]}>;
    authorizationParameters?: Record<string, string>;
}
export interface ToolAuthorizationView {operationId: string; connectionId: string; status: 'pending' | 'exchanging' | 'authorized' | 'cancelled' | 'expired' | 'failed'; url?: string; expiresAt: number; code?: string}
export interface ToolConnectionInput {id: string; type: string; name: string; values: Record<string, string>}
/** OAuth verification checks token refresh, not every downstream Tool permission or API. */
export interface ToolConnectionVerification {status: 'verified' | 'failed' | 'unsupported'; checkedAt: number; code?: string}
export interface ToolConnectionView {id: string; type: string; name: string; values: Record<string, string>; configuredSecrets: string[];
    verification?: ToolConnectionVerification;
    authorization?: {scopes: string[]; connected: boolean; clientMode?: 'application' | 'personal'; operation?: ToolAuthorizationView}}
export interface ToolConnections {
    verify?(id: string): Promise<ToolConnectionVerification>;
    saveApplication?(input: ToolOAuthApplicationInput): Promise<void>;
    removeApplication?(type: string): Promise<void>;
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
    /** Host-only transactional publication of validated connection definitions. */
    prepareRegistration?(types: ToolConnectionType[]): {commit(): void; rollback(): void};
    completeAuthorization?(callback: {state: string; code?: string; error?: string}): Promise<void>;
    accessToken?(id: string, type: string): Promise<string>;
    close?(): Promise<void>;
    register(type: ToolConnectionType): void;
    resolve(id: string, type: string): Promise<Record<string, string>>;
}

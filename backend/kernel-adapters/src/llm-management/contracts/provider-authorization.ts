import type { ChatGPTConfig } from '@itookit/driver-llm/contracts';

/** Safe view state; credentials and PKCE material never cross the application boundary. */
export interface ProviderAuthorizationState {
    supported: boolean;
    status: 'signed-out' | 'pending' | 'authorized' | 'reauthorize' | 'error';
    account?: string;
    issue?: string;
    pending?: { id: string; url: string; callbackUri: string; expiresAt: number };
}

export interface ProviderAuthorizationService {
    getProviderAuthorization(providerId: string): Promise<ProviderAuthorizationState>;
    beginProviderAuthorization(providerId: string): Promise<ProviderAuthorizationState>;
    completeProviderAuthorization(providerId: string, attemptId: string, callbackUrl: string): Promise<ProviderAuthorizationState>;
    cancelProviderAuthorization(providerId: string): Promise<ProviderAuthorizationState>;
    disconnectProviderAuthorization(providerId: string): Promise<ProviderAuthorizationState>;
}

/** Private runtime port. Only the host implements storage, OAuth and token refresh. */
export interface ProviderAuthorizationHost {
    state(providerId: string): ProviderAuthorizationState;
    begin(providerId: string): Promise<ProviderAuthorizationState>;
    complete(providerId: string, attemptId: string, callbackUrl: string): Promise<ProviderAuthorizationState>;
    cancel(providerId: string): Promise<ProviderAuthorizationState>;
    disconnect(providerId: string): Promise<ProviderAuthorizationState>;
    credentials(providerId: string): ChatGPTConfig;
    onChange(listener: () => void): () => void;
}

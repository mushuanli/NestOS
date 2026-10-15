import type { LLMProvider, ChatGPTConfig } from '@itookit/driver-llm/contracts';
import type { ProviderAuthorizationHost, ProviderAuthorizationState } from '../contracts/provider-authorization';

/** Resolve private credentials only for an explicitly selected subscription provider. */
export class ProviderAuthorization {
    constructor(private readonly host: ProviderAuthorizationHost | undefined,
        private readonly provider: (id: string) => LLMProvider | undefined) {}
    state(id: string): ProviderAuthorizationState {
        return this.host && this.provider(id)?.implementation === 'chatgpt'
            ? this.host.state(id) : { supported: false, status: 'signed-out' };
    }
    credentials(provider?: LLMProvider): ChatGPTConfig | undefined {
        if (provider?.implementation !== 'chatgpt') return undefined;
        if (!this.host) throw new Error('ChatGPT authorization is unavailable in this host');
        return this.host.credentials(provider.id);
    }
    async run(action: 'begin' | 'cancel' | 'disconnect', id: string): Promise<ProviderAuthorizationState> {
        this.require(id); return this.host![action](id);
    }
    async complete(id: string, attempt: string, callback: string): Promise<ProviderAuthorizationState> {
        this.require(id); return this.host!.complete(id, attempt, callback);
    }
    private require(id: string): void {
        if (!this.host || this.provider(id)?.implementation !== 'chatgpt') throw new Error('ChatGPT authorization is unavailable');
    }
}

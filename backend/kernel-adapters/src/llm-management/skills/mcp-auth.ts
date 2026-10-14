import type { MCPAuthentication } from '@itookit/tools/mcp-contracts';
import type { MCPConnectionOptions } from '../contracts/mcp-transport';

/** Credentials are resolved on every request, never copied into stored headers. */
export function mcpAuthenticatedFetch(auth: MCPAuthentication, resolve: MCPConnectionOptions['resolveCredential']): typeof fetch {
    return async (input, init) => {
        const secret = await resolve?.(auth.credentialRef);
        if (!secret) throw new Error('MCP credentials required');
        const headers = new Headers(init?.headers);
        const bytes = new TextEncoder().encode(`${auth.username}:${secret}`);
        const authorization = auth.type === 'basic' ? `Basic ${btoa(Array.from(bytes,b => String.fromCharCode(b)).join(''))}` : `Bearer ${secret}`;
        headers.set('Authorization', authorization);
        return fetch(input, { ...init, headers, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    };
}

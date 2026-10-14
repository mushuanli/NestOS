import { afterEach, expect, it, vi } from 'vitest';
import { mcpAuthenticatedFetch } from '../../src/llm-management/skills/mcp-auth';
afterEach(() => vi.unstubAllGlobals());
it('resolves each configuration credential per request and sends UTF-8 Basic authentication',async () => {
    const network = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch',network);
    let secret = 'first';
    const resolve = vi.fn(async (reference: string) => reference === 'office' ? secret : 'second-config');
    const office = mcpAuthenticatedFetch({type:'basic',username:'用户',credentialRef:'office'},resolve);
    const second = mcpAuthenticatedFetch({type:'bearer',credentialRef:'second'},resolve);
    await office('https://office.test/mcp'); secret = 'changed'; await office('https://office.test/mcp');
    await second('https://second.test/mcp');
    const auth = network.mock.calls.map(call => new Headers((call as unknown as [unknown,RequestInit])[1].headers).get('Authorization'));
    expect(auth).toEqual([`Basic ${Buffer.from('用户:first').toString('base64')}`,`Basic ${Buffer.from('用户:changed').toString('base64')}`,'Bearer second-config']);
    expect(network.mock.calls.every(call => (call as unknown as [unknown,RequestInit])[1].redirect === 'error')).toBe(true);
});
it('fails before contacting a server when the credential is unavailable',async () => {
    const network = vi.fn(); vi.stubGlobal('fetch',network);
    await expect(mcpAuthenticatedFetch({type:'bearer',credentialRef:'missing'},async () => '')('https://server.test/mcp')).rejects.toThrow('credentials required');
    expect(network).not.toHaveBeenCalled();
});

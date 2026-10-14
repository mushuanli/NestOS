import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { MCPServerConnection } from '../../src/llm-management/skills/mcp-client';
import { parseMcpArgs } from '../../src/llm-management/device/mcp-manager';

let server: Server | undefined, client: MCPServerConnection | undefined;
afterEach(async () => { await client?.disconnect(); server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); });

it('negotiates modern Streamable HTTP, lists all pages and preserves structured tool results', async () => {
    const seen: Array<{ method: string; headers: Record<string, unknown>; params: Record<string, any> }> = [];
    server = createServer((request, response) => {
        if (request.method !== 'POST') { response.writeHead(request.method === 'DELETE' ? 204 : 405); response.end(); return; }
        let body = ''; request.on('data', data => { body += data; });
        request.on('end', () => {
            const message = JSON.parse(body); seen.push({ method: message.method, headers: request.headers, params: message.params });
            if (message.id === undefined) { response.writeHead(202); response.end(); return; }
            const result = message.method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'test', version: '2' }, 'example/adapter': {version:1} } }
                : message.method === 'tools/list' ? { tools: [{ name: message.params.cursor ? 'second' : 'first', inputSchema: { type: 'object' } }], ...(message.params.cursor ? {} : { nextCursor: 'next' }) }
                : { content: [{ type: 'text', text: 'answer' }], structuredContent: { score: 9 } };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...result } }));
        });
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    client = new MCPServerConnection({ name: 'test', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'Bearer test' } });
    await client.connect(); expect((await client.listTools()).map(tool => tool.name)).toEqual(['first', 'second']);
    expect(await client.callTool('first', {})).toMatchObject({ structuredContent: { score: 9 } });
    expect(seen.find(item => item.method === 'tools/call')?.headers).toMatchObject({ authorization: 'Bearer test', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'first' });
    expect(seen.map(item => item.method)).not.toContain('initialize');
    for (const item of seen) {
        expect(item.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
        expect(item.headers['mcp-session-id']).toBeUndefined();
    }
    expect(await client.discover()).toMatchObject({protocolVersion:'2026-07-28',metadata:{'example/adapter':{version:1}}});
    const abort = new AbortController(); abort.abort();
    await expect(client.callTool('first', {}, { signal: abort.signal })).rejects.toThrow();
});

it('preserves quoted and JSON argument vectors without invoking a shell', () => {
    expect(parseMcpArgs('["server file.mjs","--option"]')).toEqual(['server file.mjs', '--option']);
    expect(parseMcpArgs('"server file.mjs" --option')).toEqual(['server file.mjs', '--option']);
    expect(() => parseMcpArgs('[1]')).toThrow();
});

it('rejects a successful HTTP response that is not an MCP handshake', async () => {
    server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ healthy: true }));
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    client = new MCPServerConnection({ name: 'not-mcp', transport: 'http', url: `http://127.0.0.1:${address.port}`, timeout: 1000 });
    await expect(client.connect()).rejects.toThrow();
});

async function listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server!.address(); if (!address || typeof address === 'string') throw new Error('No port');
    return `http://127.0.0.1:${address.port}/mcp`;
}

it.each(['401', '403', '503'])('rejects %s without initializing or falling back', async failure => {
    const methods: string[] = [];
    server = createServer((request, response) => {
        let body = ''; request.on('data', data => { body += data; });
        request.on('end', () => {
            const message = JSON.parse(body); methods.push(message.method);
            const reply = failure === '2025-11-25'
                ? { result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', supportedVersions: ['2025-11-25'], capabilities: {} } }
                : { error: { code: -32601, message: 'Method not found' } };
            response.writeHead(Number(failure) || 200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }));
        });
    });
    client = new MCPServerConnection({ name: 'old', transport: 'http', url: await listen(), timeout: 500 });
    await expect(client.connect()).rejects.toThrow();
    expect(client.isConnected()).toBe(false);
    expect(methods).toEqual(['server/discover']);
});

it.each(['method-not-found','2025-11-25'])('negotiates a legacy server after %s and discovers its tools',async failure => {
    const methods: string[] = [];
    server = createServer((request,response) => {
        if (request.method !== 'POST') {response.writeHead(405);response.end();return;}
        let body = '';request.on('data',data => {body += data;});
        request.on('end',() => {
            const message = JSON.parse(body);methods.push(message.method);
            if (message.id === undefined) {response.writeHead(202);response.end();return;}
            let reply: object;
            if (message.method === 'server/discover') reply = failure === 'method-not-found'
                ? {error:{code:-32601,message:'Method not found'}}
                : {result:{resultType:'complete',ttlMs:0,cacheScope:'private',supportedVersions:['2025-11-25'],capabilities:{tools:{}}}};
            else if (message.method === 'initialize') reply = {result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'legacy',version:'1'}}};
            else reply = {result:{tools:[{name:'legacy_tool',inputSchema:{type:'object'}}]}};
            response.writeHead(200,{'content-type':'application/json'});
            response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,...reply}));
        });
    });
    client = new MCPServerConnection({name:'legacy',transport:'http',url:await listen(),timeout:1000});
    await client.connect();
    expect(await client.discover()).toMatchObject({protocolVersion:'2025-11-25',tools:[{name:'legacy_tool'}]});
    expect(methods).toEqual(['server/discover','initialize','notifications/initialized','tools/list']);
});

it('rejects legacy transports before opening a connection', async () => {
    for (const transport of ['sse', 'websocket']) {
        client = new MCPServerConnection({ name: 'old', transport: transport as 'http', url: 'http://127.0.0.1:1' });
        await expect(client.connect()).rejects.toThrow('supports only stdio and Streamable HTTP');
        expect(client.isConnected()).toBe(false);
    }
});

it('streams HTTP tool progress before completion and rejects unhandled input requests', async () => {
    server = createServer((request, response) => {
        let body = ''; request.on('data', data => { body += data; });
        request.on('end', () => {
            const message = JSON.parse(body);
            if (message.method === 'tools/call' && message.params.name === 'stream') {
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {
                    progressToken: message.params._meta.progressToken, progress: 1, message: 'Reading files',
                } })}\n\n`);
                setTimeout(() => response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id,
                    result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] } })}\n\n`), 80);
                return;
            }
            const result = message.method === 'server/discover'
                ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
                : { resultType: 'input_required', requestState: 'pending-input' };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        });
    });
    client = new MCPServerConnection({ name: 'stream', transport: 'http', url: await listen(), timeout: 1000 });
    await client.connect();
    const progress: string[] = []; let done = false;
    const result = await client.callTool('stream', {}, { onProgress: value => { expect(done).toBe(false); progress.push(value.message!); } });
    done = true;
    expect(progress).toEqual(['Reading files']);
    expect(result).toMatchObject({ content: [{ text: 'done' }] });
    await expect(client.callTool('input', {})).rejects.toThrow('input_required');
});

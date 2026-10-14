import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message, ...(message.result ? { result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...message.result } } : {}) }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line); if (request.id === undefined) return;
    if (request.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') {
        send({ id: request.id, error: { code: -32600, message: 'MCP 2026-07-28 metadata required' } }); return;
    }
    let result;
    switch (request.method) {
        case 'server/discover': result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {}, prompts: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'capabilities', version: '2' } } }; break;
        case 'tools/list': result = { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }; break;
        case 'resources/list': result = { resources: [{ name: request.params.cursor ? 'Second' : 'First', uri: request.params.cursor ? 'test://second' : 'test://first' }], ...(!request.params.cursor ? { nextCursor: 'next' } : {}) }; break;
        case 'prompts/list': result = { prompts: [{ name: 'review', arguments: [{ name: 'subject', required: true }] }] }; break;
        case 'resources/read': result = { contents: [{ uri: request.params.uri, text: 'RESOURCE_CONTENT' }] }; break;
        case 'prompts/get': result = { messages: [{ role: 'user', content: { type: 'text', text: 'Review ' + request.params.arguments.subject } }] }; break;
        case 'tools/call': {
            send({ method: 'notifications/progress', params: { progressToken: request.params._meta.progressToken, progress: 1, total: 2, message: 'Searching' } });
            setTimeout(() => send({ id: request.id, result: { content: [{ type: 'text', text: 'TOOL_RESULT' }] } }), 80); return;
        }
        default: send({ id: request.id, error: { code: -32601, message: 'Method not found' } }); return;
    }
    send({ id: request.id, result });
});

import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const input = createInterface({ input: process.stdin });
input.on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') throw new Error('MCP 2026-07-28 required');
    let result = {};
    if (request.method === 'server/discover') result = {
        supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '2' } },
    };
    if (request.method === 'tools/list') result = { tools: [
        { name: 'lookup', description: 'Read the rubric', inputSchema: { type: 'object', properties: { essay: { type: 'string' } }, required: ['essay'] } },
        { name: 'store', description: 'Store supplied material', inputSchema: { type: 'object', properties: { body: { type: 'object' } }, required: ['body'] } },
    ] };
    if (request.method === 'tools/call') {
        appendFileSync(process.argv[2], JSON.stringify(request.params) + '\n');
        result = { content: [{ type: 'text', text: 'RUBRIC_FROM_MCP' }], structuredContent: { score: 9 } };
        if (request.params.name === 'store') result = {content: [{type: 'text', text: 'STORED'}], structuredContent: {saved: true}};
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...result } }) + '\n');
});

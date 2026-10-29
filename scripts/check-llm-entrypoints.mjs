#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../backend/kernel-adapters/dist', import.meta.url));

/** Follow emitted local modules; external package imports remain visible for boundary checks. */
function graph(entry) {
    const modules = new Map();
    function visit(file) {
        if (modules.has(file)) return;
        const source = readFileSync(file, 'utf8');
        modules.set(file, source);
        for (const match of source.matchAll(/(?:from\s*|import\s*|require\()["'](\.\.?\/[^"']+)["']/g))
            visit(resolve(dirname(file), match[1]));
    }
    visit(resolve(dist, entry));
    return modules;
}

for (const format of ['js', 'cjs']) {
    const codec = graph(`llm-config.${format}`);
    assert.doesNotMatch([...codec.values()].join('\n'), /LLMDeviceDriver|HostMCPTransport|LLM_PROVIDERS|@itookit\/vfs-core|@modelcontextprotocol/,
        `${format}: config entry must not load management runtime or product catalogs`);
    const core = graph(`llm-core.${format}`);
    assert.doesNotMatch([...core.values()].join('\n'), /LLM_PROVIDERS|DEFAULT_AGENTS|MODEL_PRICING|@itookit\/common/,
        `${format}: core entry must not load product catalogs or application globals`);
    const host = graph(`llm-mcp-host.${format}`);
    assert.doesNotMatch([...host.values()].join('\n'), /hostFactory|registerMCPStdioHost|snapshotMCPStdioHost/, `${format}: host bridges must remain instance scoped`);
    assert.doesNotMatch([...core.values()].join('\n'), /hostFactory|registerMCPStdioHost|snapshotMCPStdioHost/,
        `${format}: core must not load the legacy host registry`);
    const contracts = graph(`contracts.${format}`);
    assert.doesNotMatch([...contracts.values()].join('\n'),
        /LLM_PROVIDERS|MODEL_PRICING|DOUBAO_SPEECH_REFERENCE|MODEL_PRICE_CATALOG|@itookit\/vfs-core/,
        `${format}: contracts entry must not load product catalogs, price snapshots or VFS`);
}
const manifest = JSON.parse(readFileSync(new URL('../backend/kernel-adapters/package.json', import.meta.url), 'utf8'));
assert.ok(!manifest.exports['./llm'] && !manifest.publishConfig.exports['./llm'], 'Legacy LLM aggregate must not be exported');
process.stdout.write('LLM ESM/CJS entry boundaries and instance MCP isolation passed.\n');

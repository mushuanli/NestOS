import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const directory = fileURLToPath(new URL('../dist/', import.meta.url));
function graph(file, modules = new Map()) {
    if (modules.has(file)) return modules;
    const source = readFileSync(file, 'utf8'); modules.set(file, source);
    for (const match of source.matchAll(/(?:from\s*|import\s*|require\()["'](\.\.?\/[^"']+)["']/g))
        graph(resolve(dirname(file), match[1]), modules);
    return modules;
}
for (const format of ['js', 'cjs']) {
    const contracts = [...graph(resolve(directory, `contracts.${format}`)).values()].join('\n');
    assert.doesNotMatch(contracts, /LLM_PROVIDERS|MODEL_PRICING|DOUBAO_SPEECH_REFERENCE|api-docs\.deepseek\.com/,
        'Device contracts must not load provider definitions or catalog snapshots');
    const catalog = [...graph(resolve(directory, `index.${format}`)).values()].join('\n');
    assert.doesNotMatch(catalog, /@itookit\/(kernel-adapters|common|app-|llm-session|llm-flow|vfs-core)/,
        'The LLM device must not depend on its consumers');
}
console.log('LLM device ESM/CJS catalogs and portable contracts are isolated.');

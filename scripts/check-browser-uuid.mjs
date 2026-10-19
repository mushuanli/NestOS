import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const roots = ['ui', 'shared', 'apps/http-app/src/client', 'apps/web-app/src', 'apps/tauri-app/src',
    'backend', 'libraries'];
const implementations = new Set(['shared/common/src/utils/random.ts', 'libraries/llm-ui/src/random.ts', 'backend/kernel-adapters/src/utils/random.ts', 'shared/app-transport/src/rpc/random.ts',
    'backend/durable-kernel/src/infrastructure/seqfile/seqfile-core.ts', 'backend/llm-flow/src/flow-definition-store.ts',
    'backend/llm-context/src/assembly/context-assembler.ts', 'libraries/vfs-ui/src/utils/local.ts',
    'libraries/vfs-sync/src/random-id.ts', 'libraries/mindos-node-client/src/files/request-id.ts']);

export function nativeUuidCalls(source, filename = 'input.ts') {
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true), lines = [];
    const visit = node => {
        if (ts.isCallExpression(node) && /\bcrypto\b/.test(node.expression.getText(ast))
            && /randomUUID/.test(node.expression.getText(ast))) lines.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
        ts.forEachChild(node, visit);
    };
    visit(ast); return lines;
}
async function scan(directory) {
    const found = [];
    for (const entry of await readdir(path.join(root, directory), {withFileTypes: true})) {
        if (['node_modules', 'dist', '.git', 'tests'].includes(entry.name)) continue;
        const filename = path.posix.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await scan(filename));
        else if (/\.[cm]?tsx?$/.test(filename) && !/\.(test|spec|d)\.tsx?$/.test(filename) && !implementations.has(filename)) {
            found.push(...nativeUuidCalls(await readFile(path.join(root, filename), 'utf8'), filename).map(line => `${filename}:${line}`));
        }
    }
    return found;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const violations = (await Promise.all(roots.map(scan))).flat();
    if (violations.length) {console.error('Use the internal UUID helper instead of native crypto.randomUUID:\n' + violations.join('\n')); process.exitCode = 1;}
    else console.log('Browser UUID entry points use internal compatibility helpers.');
}

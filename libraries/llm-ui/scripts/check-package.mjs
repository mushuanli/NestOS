import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
assert.deepEqual(Object.keys(manifest.dependencies), ['@itookit/mdxeditor']);
assert.match(manifest.dependencies['@itookit/mdxeditor'], /^\^?\d+\.\d+\.\d+$/);
for (const key of ['peerDependencies', 'optionalDependencies']) assert.equal(Object.keys(manifest[key] ?? {}).length, 0);
assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './flow', './flow.css', './style.css']);
for (const [name, target] of Object.entries(manifest.publishConfig.exports)) {
    for (const path of typeof target === 'string' ? [target] : Object.values(target))
        assert.ok(existsSync(resolve(root, path)), `${name}: missing published artifact ${path}`);
}
function files(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? files(path) : /\.(?:ts|js|cjs)$/.test(path) ? [path] : [];
    });
}
function specifiers(text, filename) {
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true), names = new Set();
    function visit(node) {
        const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
            : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') ? node.arguments[0] : undefined;
        if (literal && ts.isStringLiteralLike(literal)) names.add(literal.text);
        ts.forEachChild(node, visit);
    }
    visit(source); return names;
}
for (const folder of ['src', 'dist']) for (const file of files(resolve(root, folder))) {
    for (const name of specifiers(readFileSync(file, 'utf8'), file)) {
        if (name.startsWith('.')) assert.ok(resolve(dirname(file), name).startsWith(root + '/'), `Escaped package: ${file} -> ${name}`);
        else assert.equal(name, '@itookit/mdxeditor', `Unexpected dependency: ${file} -> ${name}`);
    }
}
process.stdout.write('Independent llm-ui source, JavaScript, declarations and exports only depend on mdxeditor.\n');

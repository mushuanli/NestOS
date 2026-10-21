import {parseTree, findNodeAtLocation, printParseErrorCode, type ParseError, type Node} from 'jsonc-parser';

/** Parse strict JSON with deterministic locations, independent of engine error wording. */
export function parseFlowJSON(source: string): unknown {
    const errors: ParseError[] = [], tree = parseTree(source, errors, {disallowComments: true, allowTrailingComma: false, allowEmptyContent: false});
    if (errors.length) throw locatedError(printParseErrorCode(errors[0].error), source, errors[0].offset);
    if (tree) checkDuplicateKeys(tree, source);
    return JSON.parse(source);
}
function checkDuplicateKeys(node: Node, source: string): void {
    if (node.type === 'object') {
        const keys = new Set<string>();
        for (const property of node.children ?? []) {
            const key = property.children![0];
            if (keys.has(key.value)) throw locatedError(`Duplicate property: ${key.value}`, source, key.offset);
            keys.add(key.value);
        }
    }
    node.children?.forEach(child => checkDuplicateKeys(child, source));
}
function locatedError(message: string, source: string, offset: number): Error & {mark: {line: number; column: number}} {
    const prefix = source.slice(0, offset).split('\n');
    return Object.assign(new Error(message), {mark: {line: prefix.length - 1, column: prefix.at(-1)!.length}});
}
export function sourceLocation(source: string, path: string): {line: number; column: number} | undefined {
    const tree = parseTree(source);
    const parts = [...path.matchAll(/\.([A-Za-z0-9_-]+)|\[(\d+)\]/g)].map(match => match[1] ?? Number(match[2]));
    const node = tree && findNodeAtLocation(tree, parts);
    if (!node) return;
    const mark = locatedError('', source, node.offset).mark;
    return {line: mark.line + 1, column: mark.column + 1};
}

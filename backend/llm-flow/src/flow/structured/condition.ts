import type { FlowCondition, SerializableExpression } from '../../contracts';

/** A UI-friendly condition compiles to the existing serializable expression language. */
export function compileCondition(condition: FlowCondition, depth = 0): SerializableExpression {
    if (!condition || depth > 30) throw new Error('Invalid condition nesting');
    if ('all' in condition || 'any' in condition) {
        const items = 'all' in condition ? condition.all : condition.any;
        if (!Array.isArray(items) || !items.length) throw new Error('Conditions require operands');
        return { kind: 'all' in condition ? 'and' : 'or', args: items.map(item => compileCondition(item, depth + 1)) };
    }
    if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(condition.operator)) throw new Error('Invalid comparison operator');
    const operands = [conditionOperand(condition.value), conditionOperand(condition.expected)];
    const guards: SerializableExpression[] = operands.filter(operand => operand.kind === 'path').map(operand => ({ kind: 'exists', args: [operand] }));
    return { kind: 'and', args: [...guards, { kind: condition.operator, args: operands }] };
}

export function conditionOperand(value: unknown): SerializableExpression {
    const match = typeof value === 'string' ? /^\$\{(param|params|state|iteration|nodes|vars)\.([A-Za-z0-9_.-]+)\}$/.exec(value) : null;
    if (!match) return { kind: 'literal', value: value as never };
    const path = match[2].split('.');
    if (path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Unsafe condition path');
    if (match[1] === 'vars') return { kind: 'path', path: ['vars', ...path] };
    if (match[1] === 'nodes') return { kind: 'path', path: ['nodes', ...path] };
    if (match[1] === 'state') return { kind: 'path', path };
    if (match[1] === 'iteration') {
        if (match[2] !== 'round') throw new Error('Unknown iteration field');
        return { kind: 'path', path: ['round'] };
    }
    return { kind: 'path', path: ['inputs', ...path] };
}

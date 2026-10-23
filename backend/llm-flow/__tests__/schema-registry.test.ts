import { expect, it } from 'vitest';
import { FlowSchemaRegistry, flowSchemaIssue } from '../src/flow/schema-registry';
import { schemaCompatibilityIssue } from '../src/flow/schema-compat';

it('freezes registered versions and returns isolated definitions', () => {
    const registry = new FlowSchemaRegistry();
    const ref = { id: 'report', version: '1' }, schema = { type: 'string' };
    registry.register(ref, schema); schema.type = 'number';
    expect(registry.get(ref)).toEqual({ type: 'string' });
    (registry.get(ref) as any).type = 'boolean';
    expect(registry.get(ref)).toEqual({ type: 'string' });
    expect(registry.get({ id: 'report' })).toBeUndefined();
    expect(() => registry.register(ref, true)).toThrow('already registered');
});

it.each([{ $ref: '#/definitions/report' }, { minimum: 'invalid' }, { type: 'unknown' }, { items: { format: 'email' } },
    { minLength: -1 }, { maxLength: 1.5 }, { minLength: 3, maxLength: 1 }, { pattern: '[' }])(
    'rejects unsupported or invalid schemas %j', schema => {
        expect(() => new FlowSchemaRegistry().register({ id: 'report' }, schema as any)).toThrow();
    },
);

it('validates nested values, required own properties, enums and closed objects', () => {
    const schema = { type: 'object', required: ['rows'], additionalProperties: false,
        properties: { rows: { type: 'array', items: { type: 'integer', enum: [1, 2] } } } };
    expect(flowSchemaIssue(schema, { rows: [1, 2] })).toBeUndefined();
    expect(flowSchemaIssue(schema, { rows: [1, 3] })).toContain('$.rows[1]');
    expect(flowSchemaIssue(schema, { rows: [1.5] })).toContain('integer');
    expect(flowSchemaIssue(schema, { rows: [], extra: true })).toContain('$.extra');
    expect(flowSchemaIssue(schema, Object.create({ rows: [] }))).toContain('required');
    expect(flowSchemaIssue({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 })).toBeUndefined();
    expect(flowSchemaIssue({ type: 'number' }, Infinity)).toContain('number');
});

it('validates nonblank strings and measures Unicode code points across schema ports', () => {
    const schema = { type: 'string', minLength: 1, maxLength: 2, pattern: '\\S' };
    const registry = new FlowSchemaRegistry(); registry.register({ id: 'label' }, schema);
    expect(flowSchemaIssue(schema, '🌿')).toBeUndefined();
    expect(flowSchemaIssue(schema, '')).toContain('minLength');
    expect(flowSchemaIssue(schema, ' \t')).toContain('pattern');
    expect(flowSchemaIssue(schema, 'ABC')).toContain('maxLength');
});

it('proves string constraints conservatively using ranges, equal patterns, or finite enums', () => {
    const target = { type: 'string', minLength: 1, maxLength: 3, pattern: '\\S' };
    expect(schemaCompatibilityIssue({ type: 'string' }, target)).toContain('minLength');
    expect(schemaCompatibilityIssue({ ...target, minLength: 2, maxLength: 2 }, target)).toBeUndefined();
    expect(schemaCompatibilityIssue({ ...target, maxLength: 4 }, target)).toContain('maxLength');
    expect(schemaCompatibilityIssue({ ...target, pattern: '.+' }, target)).toContain('pattern');
    expect(schemaCompatibilityIssue({ type: 'string', enum: ['A', '🌿'] }, target)).toBeUndefined();
    expect(schemaCompatibilityIssue({ type: 'string', enum: ['A', ' '] }, target)).toBeDefined();
    expect(schemaCompatibilityIssue({ type: 'integer' }, { pattern: '\\S' })).toBeUndefined();
});

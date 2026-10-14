import { expect, it } from 'vitest';
import { FlowSchemaRegistry, flowSchemaIssue } from '../src/flow/schema-registry';

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

it.each([{ $ref: '#/definitions/report' }, { minimum: 'invalid' }, { type: 'unknown' }, { items: { pattern: 'x' } }])(
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

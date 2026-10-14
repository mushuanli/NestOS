import { describe, expect, it, vi } from 'vitest';
import type { DagNodeDefinition, DagPluginCatalog, FlowRevision, JsonSchemaRef, JsonValue } from '../src/contracts';
import { dataEdgeSchemaIssue } from '../src/flow/port-contract';
import { validateFlowRevision } from '../src/flow/validation';
import { validateGraphPatch } from '../src/flow/graph-patch';
import { DurableFlowExecutor } from '../src/flow/executor';

const node = (id: string): DagNodeDefinition => ({ id, name: id, plugin: id, pluginVersion: '1', config: {}, inputs: {} });
const source = node('source'), target = node('target');
const edge = { id: 'edge', from: source.id, to: target.id, kind: 'data' as const, output: 'result', input: 'input' };
function catalog(output?: JsonSchemaRef, input?: JsonSchemaRef): DagPluginCatalog {
    return { getSchema: () => true, getManifest: (id: string) => ({ id, version: '1', kind: id, title: id, category: 'test', configSchema: {},
        outputs: [{ name: 'result', required: false, order: 0, schema: id === source.id ? output : undefined }],
        inputs: [{ name: 'input', required: false, order: 0, cardinality: 'one', schema: id === target.id ? input : undefined }],
    }) } as DagPluginCatalog;
}

describe('data edge schema references', () => {
    it.each([
        [{ id: 'report', version: '1' }, { id: 'report', version: '1' }, true],
        [{ id: 'report' }, { id: 'report' }, true],
        [undefined, undefined, true],
        [{ id: 'report' }, undefined, true],
        [undefined, { id: 'report' }, false],
        [{ id: 'text' }, { id: 'report' }, false],
    ] as const)('checks declared source %j against target %j', (output, input, compatible) => {
        expect(dataEdgeSchemaIssue(edge, source, target, catalog(output, input)) === undefined).toBe(compatible);
    });

    it('rejects unresolved matching references during publish, submit and patch validation', async () => {
        const plugins = catalog({ id: 'report' }, { id: 'report' });
        plugins.getSchema = () => undefined;
        const revision = { id: 'flow', revision: 1, name: 'Flow', digest: '', createdAt: 0,
            nodes: [source, target], edges: [edge] } as unknown as FlowRevision;
        expect(validateFlowRevision(revision, plugins)).toContainEqual(expect.objectContaining({ message: expect.stringContaining('Unregistered schema') }));
        const openSession = vi.fn();
        await expect(new DurableFlowExecutor({ kernel: { openSession } as never, plugins })
            .submit('s', { nodes: [source, target], edges: [edge] })).rejects.toThrow('Unregistered schema');
        expect(openSession).not.toHaveBeenCalled();
        expect(() => validateGraphPatch({ idempotencyKey: 'patch', nodes: [target], edges: [edge] }, [source], [], source.id, plugins))
            .toThrow('Unregistered schema');
    });

    it('does not impose data schemas on a control dependency', () => {
        expect(dataEdgeSchemaIssue({ ...edge, kind: 'control' }, source, target, catalog(undefined, { id: 'report' }))).toBeUndefined();
    });

    it('blocks incompatible publish, direct execution and dynamic patches before submission', async () => {
        const plugins = catalog({ id: 'text' }, { id: 'report' });
        const revision = { id: 'flow', revision: 1, name: 'Flow', digest: '', createdAt: 0,
            nodes: [source, target], edges: [edge] } as unknown as FlowRevision;
        expect(validateFlowRevision(revision, plugins)).toContainEqual(expect.objectContaining({ code: 'incompatible-port-schema', edgeId: 'edge' }));
        const openSession = vi.fn();
        const executor = new DurableFlowExecutor({ kernel: { openSession } as never, plugins });
        await expect(executor.submit('s', { nodes: [source, target], edges: [edge] })).rejects.toThrow('Schema mismatch');
        expect(openSession).not.toHaveBeenCalled();
        expect(() => validateGraphPatch({ idempotencyKey: 'patch', nodes: [target], edges: [edge] }, [source], [], source.id, plugins)).toThrow('Schema mismatch');
    });
});

/** Catalog whose registered schemas differ per `id@version`. */
function versionedCatalog(source: JsonValue, target: JsonValue): DagPluginCatalog {
    const plugins = catalog({ id: 'report', version: '1' }, { id: 'report', version: '2' });
    plugins.getSchema = (ref: JsonSchemaRef) =>
        ref.version === '1' ? source : ref.version === '2' ? target : undefined;
    return plugins;
}

const crossVersionRevision = { id: 'flow', revision: 1, name: 'Flow', digest: '', createdAt: 0,
    nodes: [source, target], edges: [edge] } as unknown as FlowRevision;

describe('structural compatibility across versions', () => {
    it.each([
        ['identical object', { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
            { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, true],
        ['source adds an optional property', { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, required: ['title'] },
            { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, true],
        ['integer widens to number', { type: 'integer' }, { type: 'number' }, true],
        ['enum widens', { type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a', 'b', 'c'] }, true],
        ['source requires more than the target', { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, required: ['title', 'note'] },
            { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, true],
        ['target requires a property the source leaves optional', { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, required: ['title'] },
            { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, required: ['title', 'note'] }, false],
        ['type change', { type: 'string' }, { type: 'number' }, false],
        ['enum narrows', { type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a'] }, false],
        ['source may emit properties the target forbids', { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: true },
            { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false }, false],
        ['array item change', { type: 'array', items: { type: 'string' } }, { type: 'array', items: { type: 'number' } }, false],
        ['unrestricted source against a typed target', true, { type: 'object' }, false],
        ['impossible source', false, { type: 'object' }, true],
    ] as const)('%s', (_name, sourceSchema, targetSchema, compatible) => {
        const plugins = versionedCatalog(sourceSchema as JsonValue, targetSchema as JsonValue);
        expect(dataEdgeSchemaIssue(edge, source, target, plugins) === undefined).toBe(compatible);
    });

    it('accepts a compatible cross-version edge during publish and patch validation', () => {
        const plugins = versionedCatalog(
            { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
            { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        );
        expect(validateFlowRevision(crossVersionRevision, plugins)).toEqual([]);
        expect(() => validateGraphPatch({ idempotencyKey: 'patch', nodes: [target], edges: [edge] }, [source], [], source.id, plugins)).not.toThrow();
    });

    it('rejects an incompatible cross-version edge with the structural reason', () => {
        const plugins = versionedCatalog({ type: 'string' }, { type: 'number' });
        expect(validateFlowRevision(crossVersionRevision, plugins)).toContainEqual(
            expect.objectContaining({ code: 'incompatible-port-schema', message: expect.stringContaining('not assignable') }),
        );
        expect(() => validateGraphPatch({ idempotencyKey: 'patch', nodes: [target], edges: [edge] }, [source], [], source.id, plugins))
            .toThrow('not assignable');
    });
});

it('uses node-local contracts for publish, direct submit and dynamic patches', async () => {
    const plugins = catalog(); plugins.getSchema = () => undefined;
    const producer = { ...source, portSchemas: { outputs: { result: { id: 'report', version: '1', definition: { type: 'string' } } } } };
    const consumer = { ...target, portSchemas: { inputs: { input: { id: 'report', version: '1' } } } };
    const revision = { ...crossVersionRevision, nodes: [producer, consumer] } as unknown as FlowRevision;
    expect(validateFlowRevision(revision, plugins)).toEqual([]);
    expect(() => validateGraphPatch({ idempotencyKey: 'local', nodes: [consumer], edges: [edge] }, [producer], [], source.id, plugins)).not.toThrow();
    consumer.portSchemas.inputs.input.id = 'other';
    expect(validateFlowRevision(revision, plugins)[0].message).toContain('Unregistered schema');
    const openSession = vi.fn();
    await expect(new DurableFlowExecutor({ kernel: { openSession } as never, plugins })
        .submit('s', { nodes: [producer, consumer], edges: [edge] })).rejects.toThrow('Unregistered schema');
    expect(openSession).not.toHaveBeenCalled();
});

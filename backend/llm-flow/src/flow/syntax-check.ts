import {flowReferenceSource} from './structured/references';
import {parseFlowJSON, sourceLocation} from './source-json';
import type { DagPluginCatalog, DagRunSpec, FlowDraft, FlowRevision, FlowParameter } from '../contracts';
import { createFlowRevision } from '../flow-definition-store';
import { createBuiltinDagPluginRegistry } from './builtin-plugins';
import { validateFlowRevision, hasValidationErrors, type ValidationIssue } from './validation';
import {flowTemplateReferences} from '../contracts';
import { validateFields, invalidFields } from './structured/input';
import { flowToDag } from './to-dag';
import { validateFlowCallParameters, validateFlowCallConfig } from './call-parameters';

export interface FlowDiagnostic extends ValidationIssue { path?: string; line?: number; column?: number }
export interface FlowCheckResult { valid: boolean; diagnostics: FlowDiagnostic[]; flow?: FlowRevision }
export interface FlowCheckOptions {
    plugins?: DagPluginCatalog;
    parse?: (source: string) => unknown;
    resolveComposite?: (id: string, revision?: number) => Promise<FlowRevision | null>;
}

/** Check untrusted author input without executing tools, models or connection admission. */
export function checkFlowSyntax(source: string | unknown, options: FlowCheckOptions = {}): FlowCheckResult {
    let value: unknown;
    try { value = typeof source === 'string' ? (options.parse ?? parseFlowJSON)(source) : source; }
    catch (error) { return { valid: false, diagnostics: [parseDiagnostic(error, typeof source === 'string' ? source : '')] }; }
    const diagnostics = shapeDiagnostics(value);
    if (diagnostics.length) return locatedResult({ valid: false, diagnostics }, source, options);
    try {
        const raw = value as FlowDraft & FlowRevision;
        const flow = raw.draftVersion !== undefined ? createFlowRevision(raw, raw.draftVersion, raw.updatedAt ?? 0) : structuredClone(raw);
        diagnostics.push(...validateFlowRevision(explicitEdgeKinds(flow, diagnostics), options.plugins ?? createBuiltinDagPluginRegistry()));
        diagnostics.push(...parameterDiagnostics(raw), ...referenceDiagnostics(raw), ...inlineSyntaxDiagnostics(raw, options));
        for (const issue of diagnostics) if (!issue.path) {
            const node = flow.nodes.findIndex(node => node.id === issue.nodeId), edge = flow.edges.findIndex(edge => edge.id === issue.edgeId);
            issue.path = node >= 0 ? `$.nodes[${node}]` : edge >= 0 ? `$.edges[${edge}]` : '$';
        }
        return locatedResult({ valid: !hasValidationErrors(diagnostics), diagnostics, flow }, source, options);
    } catch (error) { return { valid: false, diagnostics: [{ code: 'invalid-definition', message: String(error), path: '$' }] }; }
}

function explicitEdgeKinds(flow: FlowRevision, diagnostics: FlowDiagnostic[]): FlowRevision {
    return {...flow, edges: flow.edges.map((edge, index) => {
        if (edge.kind === undefined) diagnostics.push({code: 'implicit-edge-kind', severity: 'warning', path: `$.edges[${index}].kind`, message: 'Legacy edge defaults to data; declare kind explicitly'});
        return {...edge, kind: edge.kind ?? 'data'};
    })};
}

/** Resolve child contracts as a separate offline check; no credentials are required. */
export async function checkFlowSource(source: string | unknown, options: FlowCheckOptions = {}): Promise<FlowCheckResult> {
    const result = checkFlowSyntax(source, options);
    if (!result.valid || !result.flow || !options.resolveComposite && !result.flow.functions?.length) return result;
    const slots = async (flow: FlowRevision) => ({ ...flow, connections: flow.connections?.map(slot => ({ ...slot, connectionId: slot.connectionId ?? `check:${slot.name}` })) });
    const resolve = async (id: string, revision?: number) => {
        const child = await options.resolveComposite?.(id, revision);
        if (!child) return null;
        const checked = checkFlowSyntax(child, options);
        if (!checked.valid) throw new Error(`Child ${id}: ${checked.diagnostics.map(issue => issue.message).join('; ')}`);
        return child;
    };
    try {
        const spec = await flowToDag(result.flow, undefined, undefined, resolve, [], result.flow.dependencyLocks, false, undefined, undefined, slots);
        result.diagnostics.push(...callParameterDiagnostics(result.flow, spec));
        result.valid = !hasValidationErrors(result.diagnostics);
    }
    catch (error) { result.diagnostics.push({ code: 'invalid-composition', message: String(error), path: '$.nodes' }); result.valid = false; }
    return locatedResult(result, source, options);
}

function callParameterDiagnostics(flow: FlowRevision, spec: DagRunSpec): FlowDiagnostic[] {
    const single = Object.entries(spec.parameterScopes ?? {}).flatMap(([scope, binding]) => {
        if (!binding.source) return [];
        const call = scope.slice(0, -1);
        const index = flow.nodes.findIndex(node => call === node.id || call.startsWith(`${node.id}/`));
        const node = flow.nodes[index], config = object(node?.config) ? node.config : {};
        const field = call !== node?.id ? 'flowId' : Object.hasOwn(config, 'parameters') ? 'parameters' : '';
        return validateFlowCallParameters(binding.schema, binding.values).map(issue => ({
            ...issue, nodeId: node?.id,
            path: index < 0 ? '$.nodes' : `$.nodes[${index}].config${field ? '.' + field : ''}`,
            message: `Flow call ${call}: ${issue.message}`,
        }));
    });
    const batches = Object.entries(spec.functionCalls ?? {}).flatMap(([inputId, template]) => {
        const input = spec.nodes.find(node => node.id === inputId);
        const value = (input?.config as { value?: Parameters<typeof validateFlowCallConfig>[1] })?.value ?? {};
        const call = inputId.replace(/__input$/, '');
        const index = flow.nodes.findIndex(node => call === node.id || call.startsWith(`${node.id}/`));
        return validateFlowCallConfig(template.child.parameterSchema, value).map(issue => ({ ...issue,
            nodeId: flow.nodes[index]?.id, path: index < 0 ? '$.nodes' : `$.nodes[${index}].config.parameterSets`,
            message: `Flow call ${call}: ${issue.message}` }));
    });
    return [...single, ...batches];
}

type ShapeAssert = (valid: boolean, path: string, message: string) => void;
function shapeDiagnostics(value: unknown, depth = 0, budget = { remaining: 1000 }): FlowDiagnostic[] {
    if (depth > 32 || --budget.remaining < 0) return [{ code: 'invalid-inline-functions', path: '$.functions', message: 'Inline Flow declaration limit exceeded' }];
    if (!object(value)) return [{code: 'invalid-definition', message: 'Flow must be an object', path: '$'}];
    const issues: FlowDiagnostic[] = [];
    const require: ShapeAssert = (valid, path, message) => {if (!valid) issues.push({code: 'invalid-shape', path, message});};
    rootShape(value, require);
    if (Array.isArray(value.nodes)) value.nodes.forEach((node, index) => nodeShape(node, `$.nodes[${index}]`, require));
    if (Array.isArray(value.edges)) value.edges.forEach((edge, index) => edgeShape(edge, `$.edges[${index}]`, require));
    for (const key of ['parameters', 'connections']) {
        const entries = value[key];
        if (Array.isArray(entries)) entries.forEach((item, index) => require(object(item) && typeof item.name === 'string' && !!item.name.trim(), `$.${key}[${index}]`, `${key} entry requires a name`));
    }
    if (Array.isArray(value.connections)) value.connections.forEach((slot, index) => connectionShape(slot, `$.connections[${index}]`, require));
    if (Array.isArray(value.functions)) value.functions.forEach((fn, index) => {
        issues.push(...shapeDiagnostics(fn, depth + 1, budget).map(issue => ({ ...issue, path: `$.functions[${index}]${issue.path?.slice(1) ?? ''}` })));
    });
    return issues;
}

function connectionShape(slot: unknown, path: string, require: ShapeAssert): void {
    if (!object(slot)) return;
    require(slot.required === undefined || typeof slot.required === 'boolean', `${path}.required`, 'Connection required must be a boolean');
    require(slot.connectionId === undefined || typeof slot.connectionId === 'string', `${path}.connectionId`, 'Connection binding must be a string');
    require(slot.tier === undefined || ['optimal', 'standard', 'fast'].includes(String(slot.tier)), `${path}.tier`, 'Unknown connection model tier');
    if (slot.requirements === undefined) return;
    const requirements = slot.requirements;
    require(object(requirements), `${path}.requirements`, 'Connection requirements must be an object');
    if (!object(requirements)) return;
    require(typeof requirements.operation === 'string' && !!requirements.operation.trim(), `${path}.requirements.operation`, 'Connection requirements must declare an operation');
    for (const key of ['inputModalities', 'outputModalities', 'features'])
        require(requirements[key] === undefined || Array.isArray(requirements[key]) && requirements[key].every(item => typeof item === 'string' && !!item.trim()),
            `${path}.requirements.${key}`, `Connection ${key} must be an array of nonempty strings`);
    require(requirements.responseFormats === undefined || Array.isArray(requirements.responseFormats)
        && requirements.responseFormats.every(item => ['text', 'json_object', 'json_schema'].includes(String(item))),
        `${path}.requirements.responseFormats`, 'Connection response formats must declare supported format identities');
}
function rootShape(value: Record<string, unknown>, require: ShapeAssert): void {
    require(typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id) && !value.id.includes('..'), '$.id', 'Flow requires a safe id');
    require(typeof value.name === 'string' && !!value.name.trim(), '$.name', 'Flow requires a name');
    const version = value.draftVersion ?? value.revision;
    require(typeof version === 'number' && Number.isSafeInteger(version) && version > 0, value.draftVersion === undefined ? '$.revision' : '$.draftVersion', 'Flow requires a positive draftVersion or revision');
    for (const key of ['nodes', 'edges', 'parameters', 'inputGroups', 'toolDependencies', 'connections', 'functions']) require(value[key] === undefined && !['nodes', 'edges'].includes(key) || Array.isArray(value[key]), `$.${key}`, `${key} must be an array`);
}
function nodeShape(node: unknown, path: string, require: ShapeAssert): void {
    require(object(node), path, 'Node must be an object');
    if (!object(node)) return;
    for (const key of ['id', 'name', 'plugin', 'pluginVersion']) require(typeof node[key] === 'string' && !!String(node[key]).trim(), `${path}.${key}`, `Node requires ${key}`);
    require(object(node.inputs), `${path}.inputs`, 'Node inputs must be an object');
    require(Object.hasOwn(node, 'config') && node.config !== undefined, `${path}.config`, 'Node requires config');
}
function edgeShape(edge: unknown, path: string, require: ShapeAssert): void {
    for (const key of ['id', 'from', 'to']) require(object(edge) && typeof edge[key] === 'string' && !!String(edge[key]).trim(), `${path}.${key}`, `Edge requires ${key}`);
    const legacyData = object(edge) && edge.kind === undefined && typeof edge.output === 'string' && typeof edge.input === 'string';
    require(legacyData || object(edge) && ['control', 'data'].includes(String(edge.kind)), `${path}.kind`, 'Edge kind must be control or data');
    if (object(edge) && edge.onFailure !== undefined) require(['fail', 'skip', 'continue'].includes(String(edge.onFailure)), `${path}.onFailure`, 'Invalid edge failure policy');
    if (object(edge) && edge.dependencyOnly !== undefined) require(typeof edge.dependencyOnly === 'boolean', `${path}.dependencyOnly`, 'Dependency-only flag must be boolean');
}

function parameterDiagnostics(flow: FlowDraft | FlowRevision): FlowDiagnostic[] {
    const issues: FlowDiagnostic[] = [], names = new Set<string>();
    for (const [index, parameter] of (flow.parameters ?? []).entries()) {
        const path = `$.parameters[${index}]`;
        if (names.has(parameter.name)) issues.push({ code: 'duplicate-parameter', path, message: `Duplicate parameter: ${parameter.name}` });
        names.add(parameter.name);
        try {validateParameterDeclaration(parameter);}
        catch (error) {issues.push({code: 'invalid-parameter', path, message: String(error)}); continue;}
        if (parameter.default !== undefined && invalidDefault(parameter)) issues.push({code: 'invalid-default', path: `${path}.default`, message: 'Default does not match parameter constraints'});
    }
    return issues;
}

function validateParameterDeclaration(parameter: FlowParameter): void {
    validateFields({field: parameter});
    if (parameter.options !== undefined && !Array.isArray(parameter.options)) throw new Error('Options must be an array');
    for (const key of ['required', 'integer', 'nonBlank'] as const) {
        if (parameter[key] !== undefined && typeof parameter[key] !== 'boolean') throw new Error(`Invalid ${key}`);
    }
    if (parameter.name.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Unsafe parameter name');
    if (parameter.onMissing !== undefined && !['error', 'interact'].includes(parameter.onMissing)) throw new Error('Invalid onMissing');
    validateParameterBounds(parameter);
}
function validateParameterBounds(parameter: FlowParameter): void {
    for (const key of ['minimum', 'maximum'] as const) if (parameter[key] !== undefined && !Number.isFinite(parameter[key])) throw new Error(`Invalid ${key}`);
    if (parameter.minimum !== undefined && parameter.maximum !== undefined && parameter.minimum > parameter.maximum) throw new Error('Invalid numeric bounds');
}
function invalidDefault(parameter: FlowParameter): boolean {
    if (parameter.default === null && parameter.type === 'json' && parameter.widget !== 'images') return !!parameter.options && !parameter.options.includes(null);
    const invalid = invalidFields({field: {...parameter, required: true}}, {field: parameter.default!});
    return invalid.length > 0 || parameter.integer === true && typeof parameter.default === 'number' && !Number.isInteger(parameter.default);
}

function referenceDiagnostics(flow: FlowDraft | FlowRevision): FlowDiagnostic[] {
    const names = new Set((flow.parameters ?? []).map(parameter => parameter.name));
    for (const node of flow.nodes.filter(node => node.plugin === 'builtin.input')) {
        const config = object(node.config) ? node.config : {};
        if (object(config.fields ?? config.param)) Object.keys((config.fields ?? config.param) as Record<string, unknown>).forEach(name => names.add(name));
    }
    const sources = flow.nodes.map((node, index) => ({value: [flowReferenceSource(node.config), node.inputs], path: `$.nodes[${index}]`, nodeId: node.id as string | undefined}));
    sources.push({value: [flow.outputs, flow.variables], path: '$', nodeId: undefined});
    return sources.flatMap(source => {
        const refs = flowTemplateReferences(source.value);
        return [
            ...refs.filter(ref => ref.root === 'param' && ref.path.length && !names.has(ref.path[0]) && !names.has(ref.path.join('.')))
                .map(ref => ({code: 'unknown-parameter', path: source.path, nodeId: source.nodeId, message: `Undeclared parameter: ${ref.path[0]}`})),
            ...refs.filter(ref => ref.root === 'input' && (ref.path.length !== 1 || ref.path[0] !== 'prompt'))
                .map(() => ({ code: 'unknown-runtime-input', path: source.path, nodeId: source.nodeId, message: 'Runtime input only defines input.prompt' })),
        ];
    });
}

function inlineSyntaxDiagnostics(flow: FlowDraft | FlowRevision, options: FlowCheckOptions): FlowDiagnostic[] {
    return (flow.functions ?? []).flatMap((fn, index) => checkFlowSyntax(fn, options).diagnostics.map(issue => ({
        ...issue, path: `$.functions[${index}]${issue.path?.slice(1) ?? ''}`, message: `Inline Flow ${fn.id}: ${issue.message}`,
    })));
}

function parseDiagnostic(error: unknown, source: string): FlowDiagnostic {
    const message = error instanceof Error ? error.message : String(error);
    const mark = (error as { mark?: { line: number; column: number } })?.mark;
    const position = /position (\d+)/i.exec(message);
    const prefix = source.slice(0, position ? Number(position[1]) : 0).split('\n');
    return { code: 'parse-error', message, path: '$', ...(mark ? { line: mark.line + 1, column: mark.column + 1 }
        : position ? { line: prefix.length, column: prefix.at(-1)!.length + 1 } : {}) };
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

function locatedResult(result: FlowCheckResult, source: unknown, options: FlowCheckOptions): FlowCheckResult {
    if (typeof source === 'string' && !options.parse) for (const issue of result.diagnostics) {
        if (issue.path) Object.assign(issue, sourceLocation(source, issue.path));
    }
    return result;
}

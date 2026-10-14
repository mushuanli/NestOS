import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileDispatchGraph, expandDispatchDraft, flowToDag, validateFlowRevision, createBuiltinDagPluginRegistry } from '../src/flow';
import type { FlowDraft } from '../src/contracts';

function example(): FlowDraft {
    return JSON.parse(readFileSync(new URL('./fixtures/essay-review-legacy.flow', import.meta.url), 'utf8'));
}
function revision(draft = example()) { return { ...draft, revision: 1, createdAt: 0, digest: '' }; }

describe('visible dispatch graph', () => {
    it('keeps all ten authoring nodes and compiles their wiring into the durable scope', async () => {
        const draft = example(); const before = structuredClone(draft);
        expect(draft.nodes).toHaveLength(10);
        const graph = await flowToDag(revision(draft));
        expect(draft).toEqual(before);
        expect(graph.nodes.map(node => node.id)).toEqual(['collect', 'review', 'report']);
        const config = graph.nodes[1].config as any;
        expect(config.maxRounds).toBe('${params.maxRounds}');
        expect(config.branches.map((branch: any) => branch.key)).toEqual(['content', 'structure', 'language', 'logic']);
        expect(config.branches.every((branch: any) => branch.target.plugin === 'builtin.agent')).toBe(true);
        expect(config.until.args).toHaveLength(4);
        expect(graph.edges.find(edge => edge.to === 'report')?.from).toBe('review');
    });

    it('derives required check types from connected nodes instead of a hardcoded list', () => {
        const draft = example(); draft.nodes = draft.nodes.filter(node => node.id !== 'check-logic');
        draft.edges = draft.edges.filter(edge => edge.from !== 'check-logic' && edge.to !== 'check-logic');
        const graph = compileDispatchGraph(draft);
        expect((graph.nodes[1].config as any).until.args).toHaveLength(3);
        expect(validateFlowRevision(revision(draft), createBuiltinDagPluginRegistry())).toEqual([]);
    });

    it.each(['feedback', 'aggregate', 'incoming'])('rejects broken %s connections instead of changing execution silently', kind => {
        const draft = example();
        if (kind === 'feedback') draft.edges = draft.edges.filter(edge => edge.output !== 'repeat');
        if (kind === 'aggregate') draft.edges = draft.edges.filter(edge => edge.from !== 'check-content');
        if (kind === 'incoming') draft.edges.push({ id: 'bypass', from: 'collect', to: 'check-content', kind: 'data' } as never);
        expect(validateFlowRevision(revision(draft), createBuiltinDagPluginRegistry())[0]?.code).toBe('invalid-dispatch-graph');
    });

    it.each(['orphan', 'port', 'retry', 'failure'])('rejects unsupported %s scope semantics', kind => {
        const draft = example();
        if (kind === 'orphan') draft.nodes = draft.nodes.filter(node => node.id !== 'review');
        if (kind === 'port') draft.edges.find(edge => edge.from === 'check-content')!.output = 'wrong';
        if (kind === 'retry') draft.nodes.find(node => node.id === 'judge')!.retry = { maxAttempts: 2 };
        if (kind === 'failure') draft.edges.find(edge => edge.from === 'check-content')!.onFailure = 'continue';
        expect(() => compileDispatchGraph(draft)).toThrow();
    });

    it('rejects duplicate result keys', () => {
        const draft = example(); (draft.nodes.find(node => node.id === 'check-logic')!.config as any).key = 'content';
        expect(() => compileDispatchGraph(draft)).toThrow('Duplicate dispatch key');
    });

    it('expands an existing compact Flow without mutating storage or losing stop conditions', () => {
        const compact = compileDispatchGraph(example()) as FlowDraft;
        const saved = structuredClone(compact);
        const expanded = expandDispatchDraft(compact);
        expect(compact).toEqual(saved);
        expect(expanded.nodes).toHaveLength(10);
        expect(expanded.nodes.filter(node => node.plugin === 'builtin.check')).toHaveLength(4);
        const recompiled = compileDispatchGraph(expanded);
        expect((recompiled.nodes[1].config as any).until).toEqual((compact.nodes[1].config as any).until);
        expect((recompiled.nodes[1].config as any).branches.map((branch: any) => branch.key)).toEqual(['content', 'structure', 'language', 'logic']);
        expect(validateFlowRevision(revision(expanded), createBuiltinDagPluginRegistry())).toEqual([]);
    });
});

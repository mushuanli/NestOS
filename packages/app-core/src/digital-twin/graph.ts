import { sha256HexSync } from '@itookit/llm-context';
import type { TwinMemoryData } from './domain';

export type TwinEntityKind = 'person' | 'organization' | 'project' | 'event' | 'goal';
export interface TwinGraphNode { id: string; kind: TwinEntityKind; name: string; memoryIds: string[]; aliases: string[]; }
export interface TwinGraphEdge { id: string; from: string; to: string; predicate: string; memoryIds: string[]; }
export interface TwinGraph { nodes: TwinGraphNode[]; edges: TwinGraphEdge[]; }
export interface TwinEntityAlias { targetId: string; }
export interface TwinGraphMemory { id: string; data: TwinMemoryData; supported: boolean; }
export const entityId = (kind: TwinEntityKind, key: string) => sha256HexSync(JSON.stringify([kind, key]));

/** Build a disposable view: forgotten or unsupported facts cannot leave orphaned graph evidence. */
export function knowledgeGraph(memories: TwinGraphMemory[], aliases: Map<string, TwinEntityAlias> = new Map()): TwinGraph {
    const nodes = new Map<string, TwinGraphNode>(), edges = new Map<string, TwinGraphEdge>();
    for (const memory of memories.filter(item => item.supported && item.data.state === 'active')) {
        const data = memory.data, subject = addNode(nodes, aliases, 'person', data.subjectId, data.subject, memory.id);
        if (data.project) connect(edges, subject, addNode(nodes, aliases, 'project', data.projectId ?? data.project, data.project, memory.id), 'context', memory.id);
        if (data.relation) {
            const relation = data.relation;
            const key = relationKey(data);
            connect(edges, subject, addNode(nodes, aliases, relation.targetKind, key, relation.target, memory.id), relation.predicate, memory.id);
        }
        if (['event', 'decision', 'goal', 'commitment'].includes(data.kind)) {
            const kind = ['goal', 'commitment'].includes(data.kind) ? 'goal' : 'event';
            const event = addNode(nodes, aliases, kind, memory.id, data.content, memory.id);
            connect(edges, subject, event, 'context', memory.id);
            if (data.project) connect(edges, event, addNode(nodes, aliases, 'project', data.projectId ?? data.project, data.project, memory.id), 'context', memory.id);
        }
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
function addNode(nodes: Map<string, TwinGraphNode>, aliases: Map<string, TwinEntityAlias>, kind: TwinEntityKind, key: string, name: string, memoryId: string): string {
    let id = entityId(kind, key); const seen = new Set<string>();
    while (aliases.has(id) && !seen.has(id)) { seen.add(id); id = aliases.get(id)!.targetId; }
    const node = nodes.get(id) ?? { id, kind, name, memoryIds: [], aliases: [] };
    if (!node.memoryIds.includes(memoryId)) node.memoryIds.push(memoryId);
    if (!node.aliases.includes(name)) node.aliases.push(name);
    nodes.set(id, node); return id;
}
function connect(edges: Map<string, TwinGraphEdge>, from: string, to: string, predicate: string, memoryId: string): void {
    if (from === to) return;
    const id = sha256HexSync(JSON.stringify([from, to, predicate]));
    const edge = edges.get(id) ?? { id, from, to, predicate, memoryIds: [] };
    if (!edge.memoryIds.includes(memoryId)) edge.memoryIds.push(memoryId);
    edges.set(id, edge);
}

/** Expand only one hop around explicit name matches, keeping retrieval bounded and evidence based. */
export function relatedMemories(graph: TwinGraph, query: string): Set<string> {
    const names = new Set(graph.nodes.filter(node => node.aliases.some(name => name !== 'self' && name.length >= 2
        && query.toLowerCase().includes(name.toLowerCase()))).map(node => node.id));
    return new Set(graph.edges.filter(edge => names.has(edge.from) || names.has(edge.to)).flatMap(edge => edge.memoryIds)
        .concat(graph.nodes.filter(node => names.has(node.id)).flatMap(node => node.memoryIds)));
}

function relationKey(data: TwinMemoryData): string {
    const relation = data.relation!;
    if (relation.targetKind === 'project' && relation.target === data.project) return data.projectId ?? relation.target;
    if (relation.targetKind !== 'person') return relation.target;
    if (relation.target === 'self') return 'self';
    return data.independent ? `user:${relation.target}` : `${data.entityScope ?? `source:${data.sourceId}`}:${relation.target}`;
}

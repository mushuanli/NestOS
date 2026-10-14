// @file: llm-conversation/src/flow/graph.ts
// DAG 图算法：环检测（回边 + 环上节点）。供 validation / executor / CLI 复用，
// 消除三处 Kahn / DFS 重复实现。

export interface GraphNode { id: string; }
export interface GraphEdge { id: string; from: string; to: string; }

export interface GraphCycles {
    /** 环上的边 id（回边），size===0 表示无环。 */
    backEdges: Set<string>;
    /** 环上出现的所有节点 id。 */
    loopNodes: Set<string>;
}

/**
 * DFS 找环：返回回边与环上节点。backEdges 为空即 DAG。
 * loopNodes 用于 Loop 的迭代语义（环上节点可重入）。
 */
export function findCycles(nodes: GraphNode[], edges: GraphEdge[]): GraphCycles {
    const backEdges = new Set<string>();
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
        const next = adjacency.get(edge.from) ?? [];
        next.push(edge.id);
        adjacency.set(edge.from, next);
    }
    const edgeById = new Map(edges.map(edge => [edge.id, edge]));
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const visit = (nodeId: string): void => {
        visited.add(nodeId);
        inStack.add(nodeId);
        for (const edgeId of adjacency.get(nodeId) ?? []) {
            const to = edgeById.get(edgeId)?.to;
            if (to === undefined) continue;
            if (inStack.has(to)) {
                backEdges.add(edgeId);
            } else if (!visited.has(to)) {
                visit(to);
            }
        }
        inStack.delete(nodeId);
    };
    for (const node of nodes) if (!visited.has(node.id)) visit(node.id);
    return { backEdges, loopNodes: cycleMembers(nodes, edges) };
}

interface Components {
    next: number;
    index: Map<string, number>;
    low: Map<string, number>;
    stack: string[];
    active: Set<string>;
    members: Set<string>;
    adjacency: Map<string, string[]>;
}

/** SCC membership includes parallel paths that DFS back-edge stacks miss. */
function cycleMembers(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
    const state: Components = { next: 0, index: new Map(), low: new Map(), stack: [], active: new Set(), members: new Set(), adjacency: new Map() };
    for (const edge of edges) state.adjacency.set(edge.from, [...(state.adjacency.get(edge.from) ?? []), edge.to]);
    for (const node of nodes) if (!state.index.has(node.id)) visitComponent(state, node.id);
    return state.members;
}

function visitComponent(state: Components, id: string): void {
    const index = state.next++;
    state.index.set(id, index); state.low.set(id, index);
    state.stack.push(id); state.active.add(id);
    for (const next of state.adjacency.get(id) ?? []) {
        if (!state.index.has(next)) {
            visitComponent(state, next);
            state.low.set(id, Math.min(state.low.get(id)!, state.low.get(next)!));
        } else if (state.active.has(next)) state.low.set(id, Math.min(state.low.get(id)!, state.index.get(next)!));
    }
    if (state.low.get(id) !== index) return;
    const component: string[] = [];
    let member: string;
    do { member = state.stack.pop()!; state.active.delete(member); component.push(member); } while (member !== id);
    if (component.length > 1 || state.adjacency.get(id)?.includes(id)) for (const member of component) state.members.add(member);
}

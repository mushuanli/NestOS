import {t} from '@itookit/common';
import type {FlowDraft} from '@itookit/llm-flow/contracts';

/** Overview navigation retains the original graph and node editor as the single authoring surface. */
export function mountFlowSteps(canvas: HTMLElement, draft: FlowDraft, select: (id: string) => void, expanded = false): void {
    if (!draft.layout?.steps?.length) return;
    const overview = document.createElement('nav'), graph = document.createElement('details'), summary = document.createElement('summary');
    overview.setAttribute('aria-label', t('flow.steps.overview'));
    overview.className = 'flow-steps';
    overview.addEventListener('click', event => event.stopPropagation());
    graph.open = expanded; graph.className = 'flow-steps-graph'; summary.textContent = t('flow.steps.graph');
    summary.addEventListener('click', event => event.stopPropagation());
    graph.append(summary, ...Array.from(canvas.childNodes));
    const seen = new Set<string>();
    for (const step of draft.layout.steps) {
        const nodes = step.nodes.flatMap(id => {
            const node = draft.nodes.find(item => item.id === id);
            if (!node || seen.has(id)) return [];
            seen.add(id); return [node];
        });
        if (!nodes.length) continue;
        const details = document.createElement('details'), title = document.createElement('summary');
        title.textContent = step.name; details.append(title);
        for (const node of nodes) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = node.name;
            button.addEventListener('click', () => {graph.open = true; select(node.id);}); details.append(button);
        }
        overview.append(details);
    }
    canvas.append(overview, graph);
}

// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {mountFlowSteps} from '../../llm-ui-adapter/src/components/dag/FlowSteps';

it('keeps the actual graph and routes overview selection to the original node', () => {
    const canvas = document.createElement('div'), graph = document.createElement('div'); canvas.append(graph);
    const select = vi.fn();
    mountFlowSteps(canvas, {layout: {steps: [{name: 'Review', nodes: ['a', 'a', 'missing']}]},
        nodes: [{id: 'a', name: 'Content review'}]} as never, select);
    expect(canvas.querySelectorAll('button')).toHaveLength(1);
    expect(graph.closest('details')!.open).toBe(false);
    canvas.querySelector('button')!.click();
    expect(select).toHaveBeenCalledWith('a'); expect(graph.closest('details')!.open).toBe(true);
});

it('leaves legacy graphs available without requiring overview declarations', () => {
    const canvas = document.createElement('div'); canvas.innerHTML = '<div>Graph</div>';
    mountFlowSteps(canvas, {layout: {}, nodes: []} as never, () => {});
    expect(canvas.innerHTML).toBe('<div>Graph</div>');
});

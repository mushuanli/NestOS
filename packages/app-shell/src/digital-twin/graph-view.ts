import { escapeHTML, escapeAttr } from '@itookit/common';
import type { TwinGraphNode } from '@itookit/app-core';
import { label, select, type TwinSnapshot } from './view';

export function graphView(snapshot: TwinSnapshot, selectedId = ''): string {
    const { graph } = snapshot, selected = graph.nodes.find(node => node.id === selectedId) ?? graph.nodes[0];
    const objects = graph.nodes.map(node => `<button type="button" data-action="openEntity" data-id="${escapeAttr(node.id)}" aria-current="${node.id === selected?.id}" title="${escapeAttr(nodeSource(snapshot, node))}" data-search-text="${escapeAttr(node.aliases.join(' ').toLowerCase())}">${escapeHTML(nodeName(node))} · ${escapeHTML(label(`entity.${node.kind}`))}</button>`).join('');
    return `<p>${escapeHTML(label('profileHelp'))}</p><h3>${escapeHTML(label('people'))}</h3>
        <input class="twin__search" data-search aria-label="${escapeAttr(label('search'))}" placeholder="${escapeAttr(label('search'))}">
        <div class="twin__objects">${objects || escapeHTML(label('empty'))}</div>
        ${selected ? entityDetails(snapshot, selected) : ''}`;
}
function entityDetails(snapshot: TwinSnapshot, selected: TwinGraphNode): string {
    const graph = snapshot.graph, edges = graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id);
    const neighbors = graph.nodes.filter(node => node.id !== selected.id && edges.some(edge => edge.from === node.id || edge.to === node.id));
    const memories = snapshot.memories.filter(memory => selected.memoryIds.includes(memory.id));
    return `<article class="twin__card"><h3>${escapeHTML(nodeName(selected))}</h3>
        <p>${escapeHTML(selected.aliases.map(name => name === 'self' ? label('self') : name).join(' · '))}</p>
        ${localGraph(selected, neighbors.slice(0, 12))}
        <p>${escapeHTML(label('graphHelp'))}</p>
        <ul>${edges.map(edge => {
            const other = graph.nodes.find(node => node.id === (edge.from === selected.id ? edge.to : edge.from))!;
            return `<li>${escapeHTML(edge.from === selected.id ? nodeName(selected) : nodeName(other))} → ${escapeHTML(edge.predicate === 'context' ? label('relatedContext') : edge.predicate)} → ${escapeHTML(edge.to === selected.id ? nodeName(selected) : nodeName(other))}</li>`;
        }).join('')}</ul>
        <h4>${escapeHTML(label('timeline'))}</h4>${memories.sort((a, b) => b.data.recordedAt - a.data.recordedAt).map(memory => `<details><summary>${escapeHTML(memory.data.content)}</summary>
            <p>${escapeHTML(memory.data.eventTime || new Date(memory.data.recordedAt).toLocaleString())}</p><blockquote>${escapeHTML(memory.data.quote || label('userStatement'))}</blockquote>
            <p>${escapeHTML(snapshot.sources.find(source => source.id === memory.data.sourceId)?.data.label ?? '')}</p>
            <button type="button" data-action="openMemories" data-id="${escapeAttr(memory.id)}">${escapeHTML(label('correct'))}</button></details>`).join('')}
        ${mergeForm(snapshot, selected)}</article>`;
}
function localGraph(center: TwinGraphNode, neighbors: TwinGraphNode[]): string {
    const positions = neighbors.map((node, index) => {
        const angle = 2 * Math.PI * index / neighbors.length;
        return { node, x: 320 + 225 * Math.cos(angle), y: 210 + 155 * Math.sin(angle) };
    });
    return `<svg class="twin__graph" viewBox="0 0 640 420" role="group" aria-label="${escapeAttr(label('localGraph'))}">
        ${positions.map(point => `<line x1="320" y1="210" x2="${point.x}" y2="${point.y}"/>`).join('')}
        ${[...positions, { node: center, x: 320, y: 210 }].map(point => `<a href="#" data-action="openEntity" data-id="${escapeAttr(point.node.id)}" aria-label="${escapeAttr(nodeName(point.node))}">
            <title>${escapeHTML(nodeName(point.node))}</title><circle cx="${point.x}" cy="${point.y}" r="20"/>
            <text x="${point.x}" y="${point.y + 36}" text-anchor="middle">${escapeHTML(nodeName(point.node).slice(0, 16))}</text></a>`).join('')}</svg>`;
}
function mergeForm(snapshot: TwinSnapshot, selected: TwinGraphNode): string {
    if (selected.kind !== 'person' || selected.aliases.includes('self')) return '';
    const others = snapshot.graph.nodes.filter(node => node.kind === 'person' && node.id !== selected.id && !node.aliases.includes('self'));
    if (!others.length) return '';
    return `<details><summary>${escapeHTML(label('mergePeople'))}</summary><p>${escapeHTML(label('mergePeopleHelp'))}</p>
        <form class="twin__form" data-form="mergePeople" data-id="${escapeAttr(selected.id)}">${select('mergeTarget', others.map(node => ({ id: node.id, name: nodeName(node) + ' · ' + nodeSource(snapshot, node) })))}
        <button type="submit">${escapeHTML(label('mergePeople'))}</button></form></details>`;
}
const nodeName = (node: TwinGraphNode) => node.name === 'self' ? label('self') : node.name;

function nodeSource(snapshot: TwinSnapshot, node: TwinGraphNode): string {
    const memory = snapshot.memories.find(item => node.memoryIds.includes(item.id));
    return snapshot.sources.find(source => source.id === memory?.data.sourceId)?.data.label || memory?.data.project || label('userStatement');
}

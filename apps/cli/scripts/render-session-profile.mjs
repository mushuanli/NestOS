import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Expected profile artifact directory');
const profile = JSON.parse(await readFile(path.join(directory, 'cpu.cpuprofile'), 'utf8'));
const nodes = new Map(profile.nodes.map(node => [node.id, {...node, own: 0, total: 0}]));
for (let i = 0; i < profile.samples.length; i++) nodes.get(profile.samples[i]).own += profile.timeDeltas[i];
const root = profile.nodes.find(node => node.callFrame.functionName === '(root)');
function total(id) {
    const node = nodes.get(id);
    node.total = node.own + (node.children ?? []).reduce((sum, child) => sum + total(child), 0);
    return node.total;
}
total(root.id);
const escape = value => String(value).replace(/[&<>"']/g, value => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[value]));
const rectangles = [], width = 1400, rowHeight = 20; let deepest = 0;
function draw(id, x, depth) {
    const node = nodes.get(id), size = width * node.total / nodes.get(root.id).total;
    if (size < .3) return;
    deepest = Math.max(deepest, depth);
    const label = node.callFrame.functionName || '(anonymous)', color = 15 + [...label].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 40;
    rectangles.push(`<g><title>${escape(label)} · total ${(node.total / 1000).toFixed(2)} ms · self ${(node.own / 1000).toFixed(2)} ms · ${escape(node.callFrame.url ?? '')}:${(node.callFrame.lineNumber ?? -1) + 1}</title><rect x="${x}" y="${depth * rowHeight + 45}" width="${Math.max(.1, size - .4)}" height="19" fill="hsl(${color} 85% 68%)"/>${size > 32 ? `<text x="${x + 3}" y="${depth * rowHeight + 59}">${escape(label.slice(0, Math.max(0, Math.floor(size / 7) - 1)))}</text>` : ''}</g>`);
    let childX = x;
    for (const child of [...node.children ?? []].sort((a, b) => nodes.get(b).total - nodes.get(a).total)) {
        draw(child, childX, depth + 1); childX += width * nodes.get(child).total / nodes.get(root.id).total;
    }
}
draw(root.id, 0, 0);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${(deepest + 1) * rowHeight + 65}" style="font:12px monospace;background:#fff"><text x="8" y="18">CPU sampled flame graph — includes idle and profiler overhead</text><text x="8" y="36">Hover for total/self time and source location; wall time and lock admission are in summary.json.</text>${rectangles.join('')}</svg>`;
await writeFile(path.join(directory, 'cpu-flamegraph.svg'), svg);

const spans = JSON.parse(await readFile(path.join(directory, 'spans.json'), 'utf8')), groups = new Map();
for (const span of spans) {
    const key = `${span.scenario}/${span.name}`, list = groups.get(key) ?? [];
    list.push(span.duration); groups.set(key, list);
}
const timings = [...groups].map(([name, values]) => {
    values.sort((a, b) => a - b);
    return {name, count: values.length, totalMs: +values.reduce((a, b) => a + b, 0).toFixed(2),
        p50Ms: +values[Math.ceil(values.length * .5) - 1].toFixed(3), p95Ms: +values[Math.ceil(values.length * .95) - 1].toFixed(3), maxMs: +values.at(-1).toFixed(3)};
});
const self = new Map();
for (const node of nodes.values()) {
    const key = `${node.callFrame.functionName || '(anonymous)'} · ${node.callFrame.url ?? ''}`;
    self.set(key, (self.get(key) ?? 0) + node.own / 1000);
}
const cpu = [...self].map(([name, selfMs]) => ({name, selfMs: +selfMs.toFixed(2)})).sort((a, b) => b.selfMs - a.selfMs);
const apiStorage = new Map();
for (const span of spans.filter(span => span.name.startsWith('sqlite.'))) {
    const key = `${span.scenario}/${span.api ?? 'background'}/${span.name}`, item = apiStorage.get(key) ?? {name: key, count: 0, totalMs: 0};
    item.count++; item.totalMs += span.duration; apiStorage.set(key, item);
}
await writeFile(path.join(directory, 'summary.json'), JSON.stringify({cpu, timings, apiStorage: [...apiStorage.values()]}, null, 2));
console.log(JSON.stringify({flamegraph: path.join(directory, 'cpu-flamegraph.svg'), summary: path.join(directory, 'summary.json')}));

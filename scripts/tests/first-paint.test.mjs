import {test} from 'node:test';
import assert from 'node:assert/strict';
import {firstPaintStyles} from '../first-paint.mjs';

for (const event of ['load', 'error']) test(`records stylesheet ${event} before browser modules are evaluated`, () => {
    const link = '<link rel="stylesheet" crossorigin href="/assets/app.css">';
    const html = firstPaintStyles().transformIndexHtml.handler(link);
    const handler = html.match(new RegExp(`on${event}="([^"]+)"`))?.[1];
    assert.ok(handler); const element = {dataset: {appStyles: 'loading'}, media: 'print'};
    new Function(handler).call(element);
    assert.equal(element.dataset.appStyles, event === 'load' ? 'loaded' : 'error');
    if (event === 'load') assert.equal(element.media, 'all');
    assert.ok(html.includes(`<noscript>${link}</noscript>`));
});

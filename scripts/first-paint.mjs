/** Apply non-blocking loading after Vite has resolved and bundled CSS imports. */
export function firstPaintStyles() {
    return {name: 'nestos-first-paint-styles', transformIndexHtml: {order: 'post', handler(html) {
        return html.replace(/<link\b(?=[^>]*\brel="stylesheet")[^>]*>/g, link =>
            `${link.replace(/>$/, ' data-app-styles="loading" media="print" onload="this.media=\'all\';this.dataset.appStyles=\'loaded\'" onerror="this.dataset.appStyles=\'error\'">')}<noscript>${link}</noscript>`);
    }}};
}

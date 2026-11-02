import type {EditorOptions} from '../contracts';

import type {ToolbarContext} from '@itookit/llm-ui';
const mounted = new WeakMap<HTMLElement, () => void>();

/** Consume public header slots without querying the independent chat DOM. */
export function mountEditorTitleBar(root: HTMLElement, options: Pick<EditorOptions, 'mountTitleBar'>, context: ToolbarContext, title?: HTMLElement): () => void {
    const header = context.header;
    if (!options.mountTitleBar || !header) return () => {};
    mounted.get(root)?.();
    const hidden = header.title.hidden; if (title) header.title.hidden = true;
    root.dataset.hostTitlebar = 'true';
    const release = options.mountTitleBar(root, {title: title ?? header.title, contextEmbedded: !!title, editable: !!title,
        actions: [header.status, header.extra, header.primary], menu: header.menu, menuBody: header.menuBody});
    let closed = false;
    const destroy = () => {if (closed) return; closed = true;
        release(); header.title.hidden = hidden; delete root.dataset.hostTitlebar;
        if (mounted.get(root) === destroy) mounted.delete(root);
    };
    mounted.set(root, destroy); return destroy;
}

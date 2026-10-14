import type { EditorFactory } from '@itookit/ui-common';

/** The file editor is only needed when a document opens, after the VFS sidebar paints. */
export const lazyMdxEditorFactory: EditorFactory = async (container, options) =>
    (await import('@itookit/mdx-adapter')).defaultEditorFactory(container, options);

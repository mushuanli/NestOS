/** Small entry point for boot-time menus and Flow templates. */
export { createFlowContextMenuConfig } from './flows/context-menu';
export { createAIContextMenuConfig } from './context-menu/AIContextMenu';
export { installFlowLibrary, restoreFlowLibrary } from './flows/library';

export type { FlowContextMenuOptions } from './flows/context-menu';

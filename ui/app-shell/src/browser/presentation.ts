import type { VFSNodeUI } from '@itookit/vfs-ui';

/** Application metadata becomes generic presentation before reaching the browser. */
export function decorateFileNodes(nodes: VFSNodeUI[]): VFSNodeUI[] {
  return nodes.map(node => {
    const custom = node.metadata.custom, tasks = custom.taskCount;
    return { ...node, presentation: { ...node.presentation,
      subtitle: custom._extension === '.agent' ? custom.ai_connectionLabel : undefined,
      badges: tasks && tasks.total > 0 ? [`${tasks.completed}/${tasks.total}`] : [],
      unread: !!custom.hasUnreadUpdate,
    }, children: node.children && decorateFileNodes(node.children) };
  });
}

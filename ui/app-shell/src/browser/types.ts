import type { VFSNodeUI, FileTypeDefinition } from '@itookit/vfs-ui';
import type { EditorFactory } from '@itookit/ui-common';


export interface EditorFileType extends FileTypeDefinition {
  editorFactory?: EditorFactory;
}
export type EditorResolver<Node extends VFSNodeUI = VFSNodeUI> = (node: Node) => EditorFactory | null | undefined;
export function resolveFileEditor<Node extends VFSNodeUI>(types: EditorFileType[] = [], custom?: EditorResolver<Node>): EditorResolver<Node> {
  return node => custom?.(node) ?? types.find(type => type.extensions.includes(String(node.metadata.custom._extension).toLowerCase()))?.editorFactory;
}

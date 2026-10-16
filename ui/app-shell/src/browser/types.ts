import type { VFSNodeUI, FileTypeDefinition } from '@itookit/vfs-ui';
import type { EditorFactory } from '@itookit/ui-common';


export interface EditorFileType extends FileTypeDefinition {
  contentFormat?: 'markdown' | 'text';
  editorFactory?: EditorFactory;
}
export type EditorResolver<Node extends VFSNodeUI = VFSNodeUI> = (node: Node) => EditorFactory | null | undefined;
export function resolveFileEditor<Node extends VFSNodeUI>(types: EditorFileType[] = [], custom?: EditorResolver<Node>): EditorResolver<Node> {
  return node => {
    const extension = String(node.metadata.custom._extension).toLowerCase();
    return custom?.(node) ?? types.find(type => type.extensions.some(value => value.toLowerCase() === extension))?.editorFactory;
  };
}

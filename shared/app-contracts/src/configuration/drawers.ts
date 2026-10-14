export const DRAWER_KINDS = ['agents', 'flows', 'skills', 'prompts', 'tools', 'mcp'] as const;
export type DrawerKind = typeof DRAWER_KINDS[number];
export interface Drawer { id: string; kind: DrawerKind; name: string; paths: string[]; icon?: string }
export const ungroupedId = (kind: DrawerKind): string => '/drawers/ungrouped-' + kind;
export const drawerKind = (kind?: string): kind is DrawerKind => DRAWER_KINDS.includes(kind as DrawerKind);

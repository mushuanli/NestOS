/**
 * @file common/interfaces/IHoverPreview.ts
 * @description Hover preview data for autocomplete/mention plugins.
 * Used by mdx editor and vfs-ui mention providers.
 */
export interface HoverPreviewData {
    title: string;
    contentHTML: string;
    icon?: string;
}

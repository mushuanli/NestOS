// @file: llm-ui/components/templates/IconTemplates.ts

/** Shared SVG icon fragments — avoid duplicating polylines across templates. */
export const IconTemplates = {
    chevronDown: '<polyline points="6 9 12 15 18 9"></polyline>',
    chevronUp:   '<polyline points="18 15 12 9 6 15"></polyline>',
} as const;

/** MindOS default grants; capability contracts never choose host tool access. */
export const DEFAULT_HARNESS_TOOL_IDS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash']);

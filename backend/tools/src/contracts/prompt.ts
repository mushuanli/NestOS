/** A quick prompt preset (shortcut shown in the chat input dropdown). */
export interface PromptPreset {
    name: string;
    prompt: string;
}

/** A reusable system-prompt entry in the System Prompt library (settings). */
export interface SystemPromptDefinition {
    id: string;
    name: string;
    description?: string;
    /** Multiple system segments (each becomes a role:'system' message). */
    content: string[];
    /** Quick prompt presets — part of the entry, but not referenced by flow nodes. */
    presets?: PromptPreset[];
}

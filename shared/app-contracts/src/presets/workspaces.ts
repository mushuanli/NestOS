/** Persistent workspace identities, independent of UI labels and deployment. */
export const APPLICATION_WORKSPACES = ['notes', 'emails', 'calendar', 'private', 'agents', 'projects', 'flows', 'chats'] as const;

/** Historical labels used only to locate and rename the reserved workspace. */
export const LEGACY_LOCAL_PROJECT_NAMES: readonly string[] = ['个人项目', 'Personal project'];

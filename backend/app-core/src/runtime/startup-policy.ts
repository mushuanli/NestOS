export type ApplicationStartupMode = 'interactive' | 'headless' | 'server';
export type InitializationPhase = 'before-ready' | 'background' | 'after-ready';

export interface ApplicationStartupPolicy {
    readonly llm: 'before-ready' | 'background';
    readonly mcp: 'before-ready' | 'background';
    readonly skills: 'before-ready' | 'background';
    readonly devices: 'before-ready' | 'on-demand';
    readonly projects: 'before-ready' | 'on-demand';
    readonly agents: InitializationPhase;
    readonly invocations: InitializationPhase;
    readonly drafts: InitializationPhase;
    readonly workers: InitializationPhase;
    readonly navigation: 'catalog' | 'index';
}

/** Hosts select readiness requirements; this policy performs no work. */
export function applicationStartupPolicy(mode: ApplicationStartupMode = 'headless'): ApplicationStartupPolicy {
    if (mode === 'server') return { llm: 'before-ready', mcp: 'before-ready', skills: 'before-ready', devices: 'before-ready',
        projects: 'before-ready', agents: 'before-ready', invocations: 'before-ready', drafts: 'before-ready', workers: 'before-ready', navigation: 'catalog' };
    return mode === 'interactive'
        ? { llm: 'background', mcp: 'background', skills: 'background', devices: 'on-demand', projects: 'on-demand', agents: 'after-ready', invocations: 'after-ready', drafts: 'after-ready', workers: 'after-ready', navigation: 'index' }
        : { llm: 'background', mcp: 'background', skills: 'background', devices: 'on-demand', projects: 'before-ready', agents: 'background', invocations: 'before-ready', drafts: 'background', workers: 'after-ready', navigation: 'catalog' };
}

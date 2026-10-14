export type ApplicationStartupMode = 'interactive' | 'headless';
export type InitializationPhase = 'before-ready' | 'background' | 'after-ready';

export interface ApplicationStartupPolicy {
    readonly llm: 'before-ready' | 'background';
    readonly devices: 'before-ready' | 'on-demand';
    readonly projects: 'before-ready' | 'on-demand';
    readonly agents: InitializationPhase;
    readonly invocations: InitializationPhase;
    readonly drafts: InitializationPhase;
    readonly navigation: 'catalog' | 'index';
}

/** Hosts select readiness requirements; this policy performs no work. */
export function applicationStartupPolicy(mode: ApplicationStartupMode = 'headless'): ApplicationStartupPolicy {
    return mode === 'interactive'
        ? { llm: 'background', devices: 'on-demand', projects: 'on-demand', agents: 'after-ready', invocations: 'after-ready', drafts: 'after-ready', navigation: 'index' }
        : { llm: 'background', devices: 'on-demand', projects: 'before-ready', agents: 'background', invocations: 'before-ready', drafts: 'background', navigation: 'catalog' };
}

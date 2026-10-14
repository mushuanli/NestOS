import type {
    DurableTaskProgram,
    EffectAdapter,
    KernelPlugin,
    KernelRegistration,
} from '@itookit/durable-kernel';

export interface KernelAdaptersPluginOptions {
    effects: readonly EffectAdapter[];
    programs?: readonly DurableTaskProgram[];
    onSessionClosed?: (sessionId: string) => void | Promise<void>;
}

export class KernelAdaptersPlugin implements KernelPlugin {
    readonly id = '@itookit/kernel-adapters';
    readonly version = '1';

    constructor(private readonly options: KernelAdaptersPluginOptions) {}

    install(registration: KernelRegistration): void {
        for (const program of this.options.programs ?? []) registration.registerProgram(program);
        for (const effect of this.options.effects) registration.registerEffect(effect);
    }

    onSessionClosed(sessionId: string): void | Promise<void> {
        return this.options.onSessionClosed?.(sessionId);
    }
}

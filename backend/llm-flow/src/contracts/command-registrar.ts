/** Host command registration; Flow needs no command bus implementation. */
export interface FlowCommandRegistrar {
    register(name: string, handler: (args?: unknown) => Promise<unknown>): unknown;
}

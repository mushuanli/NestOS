import type { ApplicationPort, ApplicationConfigurationPort, ConfigurationRead, ConfigurationWrite,
    ConfigurationArgs, ConfigurationResult, ConfigurationRequest } from '@itookit/app-core/application/contracts';

/** Domain-facing adapter keeps editors independent of transport and runtime ownership. */
export class ApplicationConfigurationClient implements ApplicationConfigurationPort {
    constructor(private readonly application: ApplicationPort) {}
    read<K extends ConfigurationRead>(operation: K, ...args: ConfigurationArgs<K>): Promise<ConfigurationResult<K>> {
        const input = { operation, args: wireArgs(args) } as ConfigurationRequest<ConfigurationRead>;
        return this.application.query('configuration', input) as Promise<ConfigurationResult<K>>;
    }
    execute<K extends ConfigurationWrite>(operation: K, ...args: ConfigurationArgs<K>): Promise<ConfigurationResult<K>> {
        const input = { operation, args: wireArgs(args) } as ConfigurationRequest<ConfigurationWrite>;
        return this.application.command('configuration', input) as Promise<ConfigurationResult<K>>;
    }
    subscribe(listener: () => void): () => void {
        return this.application.subscribe(event => {
            if (event.kind === 'invalidate' && ['configuration', 'all'].includes(event.scope)) listener();
        });
    }
}

function wireArgs(args: readonly unknown[]): unknown[] {
    const values = [...args];
    while (values.length && values[values.length - 1] === undefined) values.pop();
    return values;
}

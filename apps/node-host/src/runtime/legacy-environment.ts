/** Prefer the NestOS spelling while retaining existing host/service environment configuration. */
export function adoptLegacyEnvironment(): void {
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('MINDOS_') && value !== undefined) process.env['NESTOS_' + key.slice(7)] ??= value;
    }
}

import { defineConfig } from 'tsup';

export default defineConfig({
    // Bundle the source-only profile entry for plain Node startup.
    noExternal: [/^@itookit\/app-core(?:\/|$)/],
});

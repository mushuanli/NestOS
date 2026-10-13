import { defineConfig } from 'tsup';

export default defineConfig({
    // The host bundles portable workspace capabilities for plain Node startup.
    banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" },
    noExternal: [/^@itookit\//],
});

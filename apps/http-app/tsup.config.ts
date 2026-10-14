import { defineConfig } from 'tsup';
import { moduleRole } from '../../scripts/check-module-separation.mjs';

export default defineConfig({
    // The host bundles portable workspace capabilities for plain Node startup.
    banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" },
    noExternal: [/^@itookit\//],
    esbuildOptions(options) {
        options.metafile = true;
    },
    esbuildPlugins: [{ name: 'backend-module-separation', setup(build) {
        build.onEnd(result => {
            const invalid = Object.keys(result.metafile?.inputs ?? {}).filter(file => moduleRole(file) === 'frontend');
            if (invalid.length) return { errors: [{ text: 'Backend bundle loads frontend implementations: ' + invalid.join(', ') }] };
        });
    } }],
});

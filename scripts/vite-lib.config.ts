import { moduleSeparationPlugin } from './check-module-separation.mjs';
import { UserConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export interface LibConfigOptions {
  name: string;                          // UMD 全局变量名
  fileName: string;                      // 输出文件名前缀
  entry?: string;                        // 入口文件路径
  external?: (string | RegExp)[];        // 外部依赖
  globals?: Record<string, string>;      // UMD globals 映射
  rootDir: string;                       // 包的根目录 (__dirname)
}

export function createLibConfig(options: LibConfigOptions): UserConfig {
  const {
    name,
    fileName,
    entry = 'src/index.ts',
    external = [],
    globals = {},
    rootDir
  } = options;

  return {
    build: {
      lib: {
        entry: resolve(rootDir, entry),
        name,
        formats: ['es', 'umd'],
        fileName: (format) => `${fileName}.${format === 'es' ? 'js' : 'umd.cjs'}`
      },
      cssCodeSplit: false,
      rollupOptions: {
        external,
        output: {
          globals,
          assetFileNames: (assetInfo) => {
            if (assetInfo.name?.endsWith('.css')) return 'style.css';
            return assetInfo.name || 'asset';
          }
        }
      },
      sourcemap: true,
      emptyOutDir: true
    },
    plugins: [moduleSeparationPlugin('frontend'),
      dts({
        entryRoot: 'src',
        outDir: 'dist',
        insertTypesEntry: true
      })
    ]
  };
}

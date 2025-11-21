/**
 * Webpack plugin that injects a module ID → name mapping for CodePress HMR
 *
 * This plugin runs during webpack compilation and builds a mapping from numeric
 * module IDs (used in production) to human-readable module names. The mapping
 * is injected into the main bundle as window.__CP_MODULE_MAP__.
 *
 * @example
 * // next.config.js
 * const CodePressWebpackPlugin = require('@codepress/codepress-engine/webpack-plugin');
 *
 * module.exports = {
 *   webpack: (config, { isServer, dev }) => {
 *     config.plugins.push(new CodePressWebpackPlugin({ isServer, dev }));
 *     return config;
 *   }
 * };
 */

import type { Compiler, Compilation, Module as WebpackModule } from 'webpack';
import { sources } from 'webpack';

interface Asset {
  name: string;
  source: sources.Source;
}

interface ModuleMap {
  [id: string]: string;
}

export interface CodePressWebpackPluginOptions {
  /**
   * Whether this is a server-side build (Next.js specific)
   * Plugin will skip if true
   */
  isServer?: boolean;

  /**
   * Whether this is a development build
   * Plugin will skip if true (dev already has named IDs)
   */
  dev?: boolean;
}

export default class CodePressWebpackPlugin {
  /**
   * The name of the plugin
   */
  public readonly name = 'CodePressWebpackPlugin';

  private readonly options: CodePressWebpackPluginOptions;

  /**
   * @param options - Plugin options for conditional execution
   */
  constructor(options: CodePressWebpackPluginOptions = {}) {
    this.options = options;
  }

  /**
   * Apply the plugin to the webpack compiler
   */
  public apply(compiler: Compiler): void {
    // Skip if this is a server build or dev build
    if (this.options.isServer) {
      console.log('[CodePress] Skipping module map (server-side build)');
      return;
    }

    if (this.options.dev) {
      console.log('[CodePress] Skipping module map (dev build has named IDs)');
      return;
    }

    compiler.hooks.thisCompilation.tap(this.name, (compilation: Compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: this.name,
          // Run during the ADDITIONS stage to ensure all assets are present
          stage: (compilation.constructor as typeof Compilation).PROCESS_ASSETS_STAGE_ADDITIONS,
        },
        () => {
          this.processAssets(compilation, compiler);
        }
      );
    });
  }

  /**
   * Process compilation assets and inject module map
   */
  private processAssets(compilation: Compilation, compiler: Compiler): void {
    const moduleMap = this.buildModuleMap(compilation, compiler);

    if (Object.keys(moduleMap).length === 0) {
      console.warn('[CodePress] No modules found to map');
      return;
    }

    console.log(
      '[CodePress] Built module map with',
      Object.keys(moduleMap).length,
      'entries'
    );

    const mapScript = this.generateMapScript(moduleMap);
    const injected = this.injectIntoMainBundle(compilation, mapScript);

    if (!injected) {
      console.warn('[CodePress] Could not find main bundle to inject module map');
    }
  }

  /**
   * Build a mapping of module IDs to normalized paths
   */
  private buildModuleMap(compilation: Compilation, compiler: Compiler): ModuleMap {
    const moduleMap: ModuleMap = {};

    compilation.modules.forEach((module: WebpackModule) => {
      // Use ChunkGraph API instead of deprecated module.id
      const moduleId = compilation.chunkGraph.getModuleId(module);
      if (moduleId === null || moduleId === undefined) {
        return;
      }

      // Type assertion: webpack modules can have a resource property
      const moduleWithResource = module as WebpackModule & { resource?: string };
      if (!moduleWithResource.resource) {
        return;
      }

      const id = String(moduleId);
      const normalizedPath = this.normalizePath(moduleWithResource.resource, compiler.context);

      if (normalizedPath) {
        moduleMap[id] = normalizedPath;
      }
    });

    return moduleMap;
  }

  /**
   * Normalize a module path to a human-readable format
   *
   * @param resourcePath - The absolute path to the module
   * @param context - The webpack context (project root)
   * @returns Normalized path or null if path should be excluded
   */
  private normalizePath(resourcePath: string, context: string): string | null {
    let path = resourcePath;

    // Handle node_modules
    if (path.includes('node_modules')) {
      // Extract package name (handles scoped packages like @foo/bar)
      const packageMatch = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
      if (!packageMatch) {
        return null;
      }

      const packageName = packageMatch[1];

      // Extract subpath within the package (e.g., react/jsx-runtime)
      const subPathMatch = path.match(/node_modules\/[^/]+(?:\/[^/]+)?\/(.+)/);
      if (subPathMatch && subPathMatch[1]) {
        const subPath = subPathMatch[1]
          .replace(/\\/g, '/')
          .replace(/\.(jsx?|tsx?|mjs|cjs)$/, '');
        return `${packageName}/${subPath}`;
      }

      return packageName;
    }

    // Handle app code - make relative to context
    path = path
      .replace(context, '.')
      .replace(/\\/g, '/') // Normalize Windows paths
      .replace(/\.(jsx?|tsx?|mjs|cjs)$/, ''); // Remove extension

    return path;
  }

  /**
   * Generate the inline script that injects the module map
   */
  private generateMapScript(moduleMap: ModuleMap): string {
    const json = JSON.stringify(moduleMap);
    return `(function(){if(typeof window!=="undefined"){window.__CP_MODULE_MAP__=${json};console.log("[CodePress] Loaded module map with",Object.keys(window.__CP_MODULE_MAP__).length,"entries");}})();`;
  }

  /**
   * Find the main bundle and inject the map script
   *
   * @returns true if injection succeeded, false otherwise
   */
  private injectIntoMainBundle(compilation: Compilation, mapScript: string): boolean {
    // Find the main client bundle
    // Matches patterns like: main-abc123.js, static/chunks/main-abc123.js
    const mainAsset = compilation
      .getAssets()
      .find((asset: Asset) =>
        asset.name.match(/^(static\/chunks\/main-|main-)[a-f0-9]+\.js$/)
      );

    if (!mainAsset) {
      return false;
    }

    const { name, source } = mainAsset;

    // Use webpack's ConcatSource to properly concatenate sources
    // This ensures the source map and other webpack internals work correctly
    const newSource = new sources.ConcatSource(
      new sources.RawSource(mapScript + '\n'),
      source
    );

    compilation.updateAsset(name, newSource);

    console.log('[CodePress] Injected module map into', name);
    return true;
  }
}

// Also export as named export for flexibility
export { CodePressWebpackPlugin };

// CommonJS compatibility
module.exports = CodePressWebpackPlugin;
module.exports.CodePressWebpackPlugin = CodePressWebpackPlugin;
module.exports.default = CodePressWebpackPlugin;

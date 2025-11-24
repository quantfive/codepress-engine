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

import type { Compilation, Compiler, Module as WebpackModule } from "webpack";
import { sources } from "webpack";

interface Asset {
  name: string;
  source: sources.Source;
}

interface ModuleMapEntry {
  path: string;
  moduleId?: string; // Webpack module ID for requiring the module
  exports?: { [originalName: string]: string }; // Maps original export name -> minified name
}

interface ModuleMap {
  [id: string]: ModuleMapEntry | string; // Support both old and new format
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
  public readonly name = "CodePressWebpackPlugin";

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
      return;
    }

    if (this.options.dev) {
      return;
    }

    compiler.hooks.thisCompilation.tap(
      this.name,
      (compilation: Compilation) => {
        // Add runtime hook before assets are processed so the bootstrap exposes cache helpers
        this.injectRuntimeHook(compilation, compiler);

        compilation.hooks.processAssets.tap(
          {
            name: this.name,
            // Run at REPORT stage (very last) to ensure all module IDs are assigned
            // Export mangling happens at OPTIMIZE_INLINE, so mangled names are available here
            stage: (compilation.constructor as typeof Compilation)
              .PROCESS_ASSETS_STAGE_REPORT,
          },
          () => {
            this.processAssets(compilation, compiler);
          }
        );
      }
    );
  }

  /**
   * Process compilation assets and inject module map
   */
  private processAssets(compilation: Compilation, compiler: Compiler): void {
    const moduleMap = this.buildModuleMap(compilation, compiler);

    if (Object.keys(moduleMap).length === 0) {
      console.warn("[CodePress] No modules found to map");
      return;
    }

    // Extract env vars from DefinePlugin for HMR support
    const envMap = this.extractEnvVars(compiler);

    const mapScript = this.generateMapScript(moduleMap, envMap);
    const injected = this.injectIntoMainBundle(compilation, mapScript);

    if (!injected) {
      console.warn(
        "[CodePress] Could not find main bundle to inject module map"
      );
    }
  }

  /**
   * Build a mapping of module IDs to normalized paths and export names
   */
  private buildModuleMap(
    compilation: Compilation,
    compiler: Compiler
  ): ModuleMap {
    const moduleMap: ModuleMap = {};

    // Build the module map from the compilation modules

    compilation.modules.forEach((module: WebpackModule) => {
      // Type assertion: webpack modules can have a resource property
      const moduleWithResource = module as WebpackModule & {
        resource?: string;
      };

      // Use ChunkGraph API instead of deprecated module.id
      const moduleId = compilation.chunkGraph.getModuleId(module);

      if (moduleId === null || moduleId === undefined) {
        return;
      }

      // Handle modules without resource (e.g., concatenated modules)
      // These still have export info we can capture
      if (!moduleWithResource.resource) {
        // Try to get export mappings even without resource
        const exportMappings = this.captureExportMappings(module, compilation);

        if (exportMappings && Object.keys(exportMappings).length > 0) {
          const id = String(moduleId);
          // Use module identifier as fallback path
          const moduleIdentifier =
            (module as any).identifier?.() || `module_${id}`;

          // For concatenated modules, try to extract source modules
          const concatenatedModule = module as any;
          let allSourcePaths: Array<{
            normalized: string;
            runtime: string;
            module: WebpackModule;
          }> = [];

          if (
            concatenatedModule.modules &&
            Array.isArray(concatenatedModule.modules)
          ) {
            // Collect all source module paths
            for (const sourceModule of concatenatedModule.modules) {
              const sourceResource = (sourceModule as any).resource;
              if (sourceResource) {
                // Store both normalized (for module ID entry) and runtime format (with extension)
                const normalizedPath = this.normalizePath(
                  sourceResource,
                  compiler.context
                );
                // Runtime format: relative to context, with extension, no ./ prefix
                const runtimePath = sourceResource
                  .replace(compiler.context + "/", "")
                  .replace(/\\/g, "/");

                if (normalizedPath) {
                  allSourcePaths.push({
                    normalized: normalizedPath,
                    runtime: runtimePath,
                    module: sourceModule as WebpackModule,
                  });
                }
              }
            }

            // Add entries for ALL source files so runtime can find them by path
            if (allSourcePaths.length > 0) {
              // Add numeric ID entry (for backwards compat)
              moduleMap[id] = {
                path: allSourcePaths[0].normalized,
                exports: exportMappings || undefined,
              };

              // Add path-based entries for each source file (for runtime lookup)
              // Runtime expects: 'src/features/home/sections/hero/HeroSection.tsx' (with extension, no ./)
              for (const { runtime, module: sourceModule } of allSourcePaths) {
                // Prefer the outer concatenated module's export mappings, since those reflect actual
                // properties on the exported object returned by moduleId. Add a default alias to the
                // basename if present (common for default exports re-exported as named symbols).
                const baseName =
                  runtime
                    .split("/")
                    .pop()
                    ?.replace(/\.[^/.]+$/, "") || null;
                const outerExportMappings = exportMappings || {};
                const mergedExports: { [originalName: string]: string } = {
                  ...outerExportMappings,
                };
                if (
                  baseName &&
                  !mergedExports.default &&
                  Object.prototype.hasOwnProperty.call(mergedExports, baseName)
                ) {
                  mergedExports.default = mergedExports[baseName];
                }
                const finalExports =
                  Object.keys(mergedExports).length > 0
                    ? mergedExports
                    : this.captureExportMappings(
                        sourceModule as WebpackModule,
                        compilation
                      ) || undefined;
                // Key by runtime path WITH extension for fast O(1) lookup
                moduleMap[runtime] = {
                  path: runtime,
                  moduleId: id, // Add module ID so runtime can require it!
                  exports: finalExports || undefined,
                };
              }
            } else {
              // Fallback: use the identifier
              moduleMap[id] = {
                path: moduleIdentifier,
                exports: exportMappings,
              };
            }
          } else {
            // Fallback: use the identifier
            moduleMap[id] = {
              path: moduleIdentifier,
              exports: exportMappings,
            };
          }
        }
        return;
      }

      const id = String(moduleId);
      const resource = moduleWithResource.resource;
      const normalizedPath = this.normalizePath(resource, compiler.context);

      if (normalizedPath) {
        // Try to capture export mappings
        const exportMappings = this.captureExportMappings(module, compilation);
        const hasExportMappings =
          exportMappings && Object.keys(exportMappings).length > 0;

        // Runtime format: relative to context, with extension, no ./ prefix
        const runtimePath = resource
          .replace(compiler.context + "/", "")
          .replace(/\\/g, "/");

        if (hasExportMappings) {
          // Add numeric ID entry (for backwards compat)
          moduleMap[id] = {
            path: normalizedPath,
            exports: exportMappings || undefined,
          };
        } else {
          // Fallback to simple string format if no exports found
          moduleMap[id] = normalizedPath;
        }

        // Always add a path-based entry for runtime lookup (with extension, no ./)
        // so production preview can resolve modules by their source path.
        moduleMap[runtimePath] = {
          path: runtimePath,
          moduleId: id,
          ...(hasExportMappings ? { exports: exportMappings } : {}),
        };
      }
    });

    return moduleMap;
  }

  /**
   * Capture export name mappings using webpack's own mangling APIs
   * This uses ExportInfo.getUsedName() to get the mangled export names directly
   */
  private captureExportMappings(
    module: WebpackModule,
    compilation: Compilation
  ): { [originalName: string]: string } | null {
    try {
      // Use webpack's ModuleGraph to get export information
      const exportsInfo = compilation.moduleGraph.getExportsInfo(module);
      if (!exportsInfo) {
        return null;
      }

      const exportMappings: { [originalName: string]: string } = {};

      const orderedExports = exportsInfo.orderedExports;
      if (!orderedExports) {
        return null;
      }

      // Iterate through all exports and check if they were mangled
      for (const exportInfo of orderedExports) {
        const originalName = exportInfo.name;

        // Skip special exports
        if (!originalName || originalName === "__esModule") {
          continue;
        }

        // Get the mangled name using webpack's own API
        // Pass undefined as runtime to get the global mangled name
        const usedName = exportInfo.getUsedName(originalName, undefined);

        // If usedName is false, the export is unused (tree-shaken)
        if (usedName && typeof usedName === "string") {
          exportMappings[originalName] = usedName;
        }
      }

      if (Object.keys(exportMappings).length > 0) {
        return exportMappings;
      }

      return null;
    } catch (error) {
      // Silently fail - export mapping is optional
      console.warn("[CodePress] Export mapping failed:", error);
      return null;
    }
  }

  /**
   * Extract environment variable definitions from DefinePlugin
   * These are the values that get replaced at build time (e.g., process.env.NEXT_PUBLIC_*)
   */
  private extractEnvVars(compiler: Compiler): Record<string, string> {
    const envMap: Record<string, string> = {};

    // Find DefinePlugin in the compiler's plugins
    for (const plugin of compiler.options.plugins || []) {
      if (plugin?.constructor?.name === "DefinePlugin") {
        const definitions =
          (plugin as { definitions?: Record<string, unknown> }).definitions ||
          {};
        for (const [key, value] of Object.entries(definitions)) {
          // Match process.env.* patterns
          if (key.startsWith("process.env.")) {
            const envKey = key.replace("process.env.", "");
            // DefinePlugin values are JSON-stringified (e.g., '"value"')
            // Parse to get the actual value
            if (typeof value === "string") {
              try {
                envMap[envKey] = JSON.parse(value);
              } catch {
                envMap[envKey] = value;
              }
            } else if (value !== undefined && value !== null) {
              envMap[envKey] = String(value);
            }
          }
        }
      }
    }
    return envMap;
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
    if (path.includes("node_modules")) {
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
          .replace(/\\/g, "/")
          .replace(/\.(jsx?|tsx?|mjs|cjs)$/, "");
        return `${packageName}/${subPath}`;
      }

      return packageName;
    }

    // Handle app code - make relative to context
    path = path
      .replace(context, ".")
      .replace(/\\/g, "/") // Normalize Windows paths
      .replace(/\.(jsx?|tsx?|mjs|cjs)$/, ""); // Remove extension

    return path;
  }

  /**
   * Generate the inline script that injects the module map and env vars
   */
  private generateMapScript(
    moduleMap: ModuleMap,
    envMap: Record<string, string>
  ): string {
    const mapJson = JSON.stringify(moduleMap);
    const envJson = JSON.stringify(envMap);
    return `(function(){if(typeof window!=="undefined"){window.__CP_MODULE_MAP__=${mapJson};window.__CP_ENV_MAP__=${envJson};console.log("[CodePress] Loaded module map with",Object.keys(window.__CP_MODULE_MAP__).length,"entries and",Object.keys(window.__CP_ENV_MAP__).length,"env vars");}})();`;
  }

  /**
   * Inject a runtime module to expose webpack module cache and make exports writable.
   */
  private injectRuntimeHook(
    compilation: Compilation,
    compiler: Compiler
  ): void {
    const wp: any = (compiler as any).webpack;
    if (!wp || !wp.RuntimeModule || !wp.Template || !wp.RuntimeGlobals) {
      console.warn(
        "[CodePress] Webpack runtime APIs unavailable; skipping cache exposure hook"
      );
      return;
    }

    const { RuntimeModule, Template, RuntimeGlobals } = wp as any;

    class ExposeCacheRuntimeModule extends (RuntimeModule as any) {
      constructor() {
        super("CodePressExposeCache");
      }
      generate() {
        return Template.asString([
          "try {",
          "  var req = __webpack_require__;",
          '  if (req && typeof req.c === "undefined" && typeof __webpack_module_cache__ !== "undefined") {',
          "    req.c = __webpack_module_cache__;",
          "  }",
          '  if (req && typeof req.makeWritable !== "function" && typeof __webpack_module_cache__ !== "undefined") {',
          "    req.makeWritable = function(id) {",
          "      try {",
          "        var mod = __webpack_module_cache__[id];",
          "        if (!mod || !mod.exports) return;",
          "        var exp = mod.exports;",
          "        Object.getOwnPropertyNames(exp).forEach(function(key) {",
          "          try {",
          "            var desc = Object.getOwnPropertyDescriptor(exp, key);",
          "            if (!desc) return;",
          "            if (desc.configurable === false || desc.writable === false) {",
          "              Object.defineProperty(exp, key, { configurable: true, writable: true, enumerable: desc.enumerable, value: exp[key] });",
          "            }",
          "          } catch (_e) {}",
          "        });",
          "        return exp;",
          "      } catch (_err) { return; }",
          "    };",
          "  }",
          "} catch (_e) {}",
        ]);
      }
    }

    compilation.hooks.runtimeRequirementInTree
      .for(RuntimeGlobals.require)
      .tap(this.name, (chunk: any) => {
        compilation.addRuntimeModule(
          chunk,
          new ExposeCacheRuntimeModule() as any
        );
        return true;
      });
  }

  /**
   * Find the main bundle and inject the map script
   *
   * @returns true if injection succeeded, false otherwise
   */
  private injectIntoMainBundle(
    compilation: Compilation,
    mapScript: string
  ): boolean {
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
      new sources.RawSource(mapScript + "\n"),
      source
    );

    compilation.updateAsset(name, newSource);

    return true;
  }
}

// Also export as named export for flexibility
export { CodePressWebpackPlugin };

// CommonJS compatibility
module.exports = CodePressWebpackPlugin;
module.exports.CodePressWebpackPlugin = CodePressWebpackPlugin;
module.exports.default = CodePressWebpackPlugin;

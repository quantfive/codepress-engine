/**
 * Webpack plugin that injects a module ID → name mapping for CodePress HMR
 *
 * This plugin runs during webpack compilation and builds a mapping from numeric
 * module IDs (used in production) to human-readable module names. The mapping
 * is injected into the main bundle as window.__CP_MODULE_MAP__.
 *
 * Note: Environment variables (window.__CP_ENV_MAP__) are now injected by the
 * SWC plugin at transform time, not by this webpack plugin.
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

interface NpmExportEntry {
  moduleId: string;
  exportName: string; // The minified export name (e.g., "A")
}

interface NpmPackageEntry {
  type: "npm";
  exports: { [originalName: string]: NpmExportEntry }; // Maps export name -> module info
}

interface ModuleMap {
  [id: string]: ModuleMapEntry | NpmPackageEntry | string; // Support app code, npm packages, and legacy format
}

export interface CodePressWebpackPluginOptions {
  /**
   * Whether this is a server-side build (Next.js specific)
   * Plugin will skip if true
   */
  isServer?: boolean;

  /**
   * Whether this is a development build
   * Plugin will skip if true (dev already has named IDs, and env vars are handled by SWC plugin)
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
   * Get alias mappings from webpack's resolve configuration AND tsconfig.json.
   * Returns a map of alias prefix -> resolved directory path.
   *
   * For example, with tsconfig paths: { "@/*": ["./src/*"] }
   * This returns: { "@": "src" }
   */
  private getAliasMap(compiler: Compiler): Map<string, string> {
    const aliases = new Map<string, string>();

    // First, try webpack's resolve.alias
    const resolveAlias = compiler.options.resolve?.alias;
    if (resolveAlias && typeof resolveAlias === "object") {
      for (const [alias, target] of Object.entries(resolveAlias)) {
        if (typeof target === "string") {
          // Convert absolute path to relative (e.g., /project/src -> src)
          let relativePath = target.replace(compiler.context + "/", "");
          // Remove trailing slash if present
          relativePath = relativePath.replace(/\/$/, "");
          aliases.set(alias, relativePath);
        } else if (Array.isArray(target) && typeof target[0] === "string") {
          // Handle array format: ["path1", "path2"]
          let relativePath = target[0].replace(compiler.context + "/", "");
          relativePath = relativePath.replace(/\/$/, "");
          aliases.set(alias, relativePath);
        }
      }
    }

    // Always try to read @ alias from tsconfig.json if not already present
    // resolve.alias usually has Next.js internals but not the @ path alias
    const fs = require("fs");
    const path = require("path");

    if (!aliases.has("@")) {
      const tsconfigPath = path.join(compiler.context, "tsconfig.json");

      try {
        if (fs.existsSync(tsconfigPath)) {
          const tsconfigContent = fs.readFileSync(tsconfigPath, "utf8");

          // Extract paths directly using regex (avoids JSON parsing issues with comments/globs)
          // Match: "paths": { "@/*": ["./src/*"] } or similar
          const pathsMatch = tsconfigContent.match(
            /"paths"\s*:\s*\{([^}]+)\}/
          );

          if (pathsMatch) {
            const pathsContent = pathsMatch[1];

            // Extract individual path mappings: "@/*": ["./src/*"]
            const pathPattern = /"([^"]+)"\s*:\s*\[\s*"([^"]+)"/g;
            let match;
            while ((match = pathPattern.exec(pathsContent)) !== null) {
              const aliasPattern = match[1]; // "@/*"
              const targetPattern = match[2]; // "./src/*"

              // Convert "@/*" -> "@" and "./src/*" -> "src"
              const alias = aliasPattern.replace(/\/\*$/, "");
              const targetPath = targetPattern
                .replace(/^\.\//, "")
                .replace(/\/\*$/, "");

              aliases.set(alias, targetPath);
            }
          }
        }
      } catch (e) {
        console.warn("[CodePress] Error reading tsconfig.json:", e);
      }

      // Fallback: Next.js convention is @/* -> ./src/*
      if (!aliases.has("@")) {
        const srcDir = path.join(compiler.context, "src");
        if (fs.existsSync(srcDir)) {
          aliases.set("@", "src");
        }
      }
    }

    return aliases;
  }

  /**
   * Convert a real path to its aliased version if applicable.
   * For example: "src/components/Foo.tsx" with alias "@" -> "src"
   * Returns: "@/components/Foo" (without extension)
   */
  private pathToAlias(
    realPath: string,
    aliasMap: Map<string, string>
  ): string | null {
    for (const [alias, targetDir] of aliasMap) {
      if (realPath.startsWith(targetDir + "/")) {
        // Replace the target dir with the alias
        const withoutDir = realPath.slice(targetDir.length + 1);
        // Remove extension for the alias version
        const withoutExt = withoutDir.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
        return `${alias}/${withoutExt}`;
      }
    }
    return null;
  }

  /**
   * Apply the plugin to the webpack compiler
   */
  public apply(compiler: Compiler): void {
    // Skip server builds entirely
    if (this.options.isServer) {
      return;
    }

    // Skip dev mode - module mapping not needed (dev has named IDs)
    // and env vars are handled by the SWC plugin
    if (this.options.dev) {
      return;
    }

    // Disable optimizations that break CodePress preview in production builds.
    // This is REQUIRED for CodePress preview to work because:
    //
    // 1. Module Concatenation (scope hoisting): Merges multiple source files into one,
    //    making internal components inaccessible via exports.
    //
    // 2. Used Exports tracking (tree-shaking): Removes "unused" exports from modules.
    //    If app uses `import Foo from './Foo'` but preview uses `import { Foo }`,
    //    the named export won't exist. Disabling this preserves ALL exports.
    //
    // Bundle size impact: ~10-20% larger, but acceptable for preview functionality.
    // The extra code is still minified and gzips well.
    //
    // We use the 'environment' hook which runs early, before plugins are applied,
    // to ensure our settings take effect before Next.js can override them.
    compiler.hooks.environment.tap(this.name, () => {
      if (compiler.options.optimization) {
        compiler.options.optimization.concatenateModules = false;
        compiler.options.optimization.usedExports = false;
      }
    });

    compiler.hooks.thisCompilation.tap(
      this.name,
      (compilation: Compilation) => {
        // Production mode: module mapping + runtime hooks
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

    const mapScript = this.generateMapScript(moduleMap);
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

    // Get alias map for generating alias-based keys
    const aliasMap = this.getAliasMap(compiler);

    // Collect npm package exports for aggregation
    // Map of package name -> { exportName -> { moduleId, minifiedName } }
    const npmPackageExports = new Map<
      string,
      Map<string, { moduleId: string; exportName: string }>
    >();

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

              // For concatenated modules, we need to trace exports from the OUTER module
              // back to each source module. The outer module has the final minified names.
              // Build a map: sourceModule -> { originalName -> finalMinifiedName }
              const sourceModuleExports = this.traceExportsToSourceModules(
                module,
                concatenatedModule.modules,
                compilation
              );

              // Add path-based entries for each source file (for runtime lookup)
              // Runtime expects: 'src/features/home/sections/hero/HeroSection.tsx' (with extension, no ./)
              for (const { runtime, module: sourceModule } of allSourcePaths) {
                // Get the traced export mappings for this source module
                const tracedExports = sourceModuleExports.get(sourceModule);

                // Add a default alias to the basename if present
                // (common for default exports re-exported as named symbols)
                const baseName =
                  runtime
                    .split("/")
                    .pop()
                    ?.replace(/\.[^/.]+$/, "") || null;

                const finalExports: { [originalName: string]: string } = {
                  ...(tracedExports || {}),
                };

                if (
                  baseName &&
                  !finalExports.default &&
                  Object.prototype.hasOwnProperty.call(finalExports, baseName)
                ) {
                  finalExports.default = finalExports[baseName];
                }

                // Key by runtime path WITH extension for fast O(1) lookup
                moduleMap[runtime] = {
                  path: runtime,
                  moduleId: id, // Add module ID so runtime can require it!
                  exports:
                    Object.keys(finalExports).length > 0
                      ? finalExports
                      : undefined,
                };

                // Also add alias-based key for direct O(1) lookup
                const aliasPath = this.pathToAlias(runtime, aliasMap);
                if (aliasPath) {
                  moduleMap[aliasPath] = {
                    path: runtime,
                    moduleId: id,
                    exports:
                      Object.keys(finalExports).length > 0
                        ? finalExports
                        : undefined,
                  };
                  // For index files, also add a key without /index suffix
                  // so imports like "@/features/dashboard" resolve to "@/features/dashboard/index"
                  if (aliasPath.endsWith("/index")) {
                    const withoutIndex = aliasPath.replace(/\/index$/, "");
                    moduleMap[withoutIndex] = {
                      path: runtime,
                      moduleId: id,
                      exports:
                        Object.keys(finalExports).length > 0
                          ? finalExports
                          : undefined,
                    };
                  }
                }
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

        // Check if this is an npm package and collect its exports
        const npmPackageName = this.extractNpmPackageName(resource);
        if (npmPackageName) {
          // Get or create the package's export map
          if (!npmPackageExports.has(npmPackageName)) {
            npmPackageExports.set(npmPackageName, new Map());
          }
          const packageExports = npmPackageExports.get(npmPackageName)!;

          if (hasExportMappings) {
            // Add each export to the package's map using webpack's export info
            for (const [originalName, minifiedName] of Object.entries(
              exportMappings
            )) {
              // Store the export with its module ID and minified name
              packageExports.set(originalName, {
                moduleId: id,
                exportName: minifiedName,
              });
            }

            // Special handling for default exports in icon libraries like lucide-react:
            // If this module has a "default" export, also add an entry using the
            // derived name from the file path. This allows `import { ChevronLeft }`
            // to work even though the module exports it as `default`.
            // e.g., "lucide-react/dist/esm/icons/chevron-left.js" with default export
            //       -> also add "ChevronLeft" pointing to the default export
            if (exportMappings.default) {
              const derivedName = this.deriveExportNameFromPath(resource);
              if (
                derivedName &&
                derivedName !== "default" &&
                !packageExports.has(derivedName)
              ) {
                packageExports.set(derivedName, {
                  moduleId: id,
                  exportName: exportMappings.default, // Use the minified default export name
                });
              }
            }

          } else {
            // No export mappings - derive export name from file path
            // e.g., "recharts/es6/polar/PolarGrid.js" -> "PolarGrid"
            const derivedName = this.deriveExportNameFromPath(resource);
            if (derivedName) {
              // Assume "default" export since we don't have explicit mappings
              // Runtime will need to handle this appropriately
              packageExports.set(derivedName, {
                moduleId: id,
                exportName: "default",
              });
            }
          }
        }

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

        // Also add alias-based key for direct O(1) lookup
        // e.g., "src/components/Foo.tsx" -> "@/components/Foo"
        const aliasPath = this.pathToAlias(runtimePath, aliasMap);
        if (aliasPath) {
          moduleMap[aliasPath] = {
            path: runtimePath,
            moduleId: id,
            ...(hasExportMappings ? { exports: exportMappings } : {}),
          };
          // For index files, also add a key without /index suffix
          // so imports like "@/features/dashboard" resolve to "@/features/dashboard/index"
          if (aliasPath.endsWith("/index")) {
            const withoutIndex = aliasPath.replace(/\/index$/, "");
            moduleMap[withoutIndex] = {
              path: runtimePath,
              moduleId: id,
              ...(hasExportMappings ? { exports: exportMappings } : {}),
            };
          }
        }
      }
    });

    // Aggregate npm package exports into MODULE_MAP entries
    // This creates entries like:
    // "lucide-react": { type: "npm", exports: { "ChevronDown": { moduleId: "123", exportName: "A" }, ... } }
    for (const [packageName, exportsMap] of npmPackageExports) {
      // Convert the Map to a plain object for JSON serialization
      const exportsObj: { [originalName: string]: NpmExportEntry } = {};
      for (const [exportName, exportInfo] of exportsMap) {
        exportsObj[exportName] = exportInfo;
      }

      // Only add if we have exports (don't add empty packages)
      if (Object.keys(exportsObj).length > 0) {
        moduleMap[packageName] = {
          type: "npm",
          exports: exportsObj,
        };
      }
    }

    return moduleMap;
  }

  /**
   * Trace exports from a concatenated module back to their source modules.
   * Returns a Map from source module to { originalName -> finalMinifiedName }
   *
   * This method uses ONLY webpack's getTarget() API which is 100% accurate.
   * It traces from the outer module's exports backwards to find which source
   * module each export originates from.
   *
   * IMPORTANT: If a source module's export is NOT re-exported by the barrel file,
   * it will NOT appear in the result. This is correct behavior because such exports
   * cannot be patched through __webpack_require__(moduleId).exports anyway.
   */
  private traceExportsToSourceModules(
    concatenatedModule: WebpackModule,
    sourceModules: WebpackModule[],
    compilation: Compilation
  ): Map<WebpackModule, { [originalName: string]: string }> {
    const result = new Map<WebpackModule, { [originalName: string]: string }>();

    // Build a quick lookup set for source modules
    const sourceModuleSet = new Set(sourceModules);
    for (const sourceModule of sourceModules) {
      result.set(sourceModule, {});
    }

    // Debug flag - set CODEPRESS_DEBUG_EXPORTS=1 to see tracing details
    const DEBUG_TRACING = process.env.CODEPRESS_DEBUG_EXPORTS === "1";

    try {
      // Get the concatenated module's export info (has final minified names)
      const outerExportsInfo =
        compilation.moduleGraph.getExportsInfo(concatenatedModule);
      if (!outerExportsInfo || !outerExportsInfo.orderedExports) {
        return result;
      }

      if (DEBUG_TRACING) {
        const outerExports: string[] = [];
        for (const ei of outerExportsInfo.orderedExports) {
          if (ei.name && ei.name !== "__esModule") {
            const minified = ei.getUsedName(ei.name, undefined);
            outerExports.push(`${ei.name}→${minified}`);
          }
        }
        console.log(
          `[CodePress DEBUG] Concatenated module exports: ${outerExports.join(", ")}`
        );
      }

      // Trace from outer exports back to source modules using getTarget()
      // This is webpack's authoritative API - no heuristics
      for (const exportInfo of outerExportsInfo.orderedExports) {
        const outerExportName = exportInfo.name;
        if (!outerExportName || outerExportName === "__esModule") continue;

        const finalMinifiedName = exportInfo.getUsedName(
          outerExportName,
          undefined
        );
        if (!finalMinifiedName || typeof finalMinifiedName !== "string")
          continue;

        // Use webpack's getTarget() to trace this export back to its source module
        const target = exportInfo.getTarget(compilation.moduleGraph);
        if (target && target.module && sourceModuleSet.has(target.module)) {
          // Found the source module for this export
          const sourceExports = result.get(target.module)!;
          // The original name in the source module is in target.export[0]
          const originalNameInSource = target.export && target.export[0];
          if (
            originalNameInSource &&
            typeof originalNameInSource === "string"
          ) {
            sourceExports[originalNameInSource] = finalMinifiedName;
            if (DEBUG_TRACING) {
              const resource = (target.module as any).resource || "unknown";
              console.log(
                `[CodePress DEBUG] Traced: ${outerExportName}→${finalMinifiedName} from ${resource.split("/").pop()}:${originalNameInSource}`
              );
            }
          } else {
            // If no export array, the name is the same as the outer export name
            sourceExports[outerExportName] = finalMinifiedName;
            if (DEBUG_TRACING) {
              const resource = (target.module as any).resource || "unknown";
              console.log(
                `[CodePress DEBUG] Traced: ${outerExportName}→${finalMinifiedName} from ${resource.split("/").pop()} (same name)`
              );
            }
          }
        } else if (DEBUG_TRACING) {
          // Export exists in outer module but getTarget() didn't find a source module
          // This can happen if the export is defined directly in the barrel file
          const targetModule = target?.module;
          const inSourceSet = targetModule
            ? sourceModuleSet.has(targetModule)
            : false;
          console.log(
            `[CodePress DEBUG] No source found for: ${outerExportName}→${finalMinifiedName} (target.module=${!!targetModule}, inSourceSet=${inSourceSet})`
          );
        }
      }
    } catch (error) {
      console.warn("[CodePress] Export tracing failed:", error);
    }

    return result;
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
   * Extract the npm package name from a resource path.
   * Returns null if the path is not from node_modules.
   *
   * @example
   * "/project/node_modules/lucide-react/dist/esm/icons/ChevronDown.js" -> "lucide-react"
   * "/project/node_modules/@radix-ui/react-dialog/dist/index.js" -> "@radix-ui/react-dialog"
   */
  private extractNpmPackageName(resourcePath: string): string | null {
    if (!resourcePath.includes("node_modules")) {
      return null;
    }

    // Match package name (handles scoped packages like @foo/bar)
    const match = resourcePath.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
    return match ? match[1] : null;
  }

  /**
   * Derive an export name from a file path.
   * Used when we don't have explicit export mappings.
   *
   * @example
   * "/project/node_modules/recharts/es6/polar/PolarGrid.js" -> "PolarGrid"
   * "/project/node_modules/lucide-react/dist/esm/icons/chevron-down.js" -> "ChevronDown"
   */
  private deriveExportNameFromPath(resourcePath: string): string | null {
    // Extract filename from path, remove extension
    const parts = resourcePath.split("/");
    let filename = parts[parts.length - 1];
    if (!filename) return null;

    filename = filename.replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, "");

    // Skip index files - they're typically re-exports
    if (filename === "index" || filename === "main") return null;

    // If already PascalCase, use as-is
    if (/^[A-Z]/.test(filename)) {
      return filename;
    }

    // Convert kebab-case or snake_case to PascalCase
    if (/[-_]/.test(filename)) {
      return filename
        .split(/[-_]/)
        .map((part) => {
          if (!part) return "";
          return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        })
        .join("");
    }

    // camelCase - just capitalize first letter
    return filename.charAt(0).toUpperCase() + filename.slice(1);
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
   * Generate the inline script that injects the module map
   */
  private generateMapScript(moduleMap: ModuleMap): string {
    const mapJson = JSON.stringify(moduleMap);
    return `(function(){if(typeof window!=="undefined"){window.__CP_MODULE_MAP__=${mapJson};}})();`;
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
    const assets = compilation.getAssets();
    const assetNames = assets.map((a: Asset) => a.name);

    // Find the main client bundle
    // Matches patterns like: main-abc123.js, static/chunks/main-abc123.js, main-app-abc123.js
    const mainPattern = /^(static\/chunks\/)?(main-|main-app-)[a-f0-9]+\.js$/;
    const mainAsset = assets.find((asset: Asset) =>
      asset.name.match(mainPattern)
    );

    if (!mainAsset) {
      // Try alternative patterns for different Next.js versions
      const altPatterns = [
        /^(static\/chunks\/)?pages\/_app-[a-f0-9]+\.js$/,
        /^(static\/chunks\/)?app-[a-f0-9]+\.js$/,
        /^_app-[a-f0-9]+\.js$/,
      ];

      for (const pattern of altPatterns) {
        const altAsset = assets.find((asset: Asset) =>
          asset.name.match(pattern)
        );
        if (altAsset) {
          return this.doInject(compilation, altAsset, mapScript);
        }
      }

      const jsAssets = assetNames.filter((n: string) => n.endsWith(".js"));
      console.warn(
        `[CodePress] Could not find main bundle. Available: ${jsAssets.slice(0, 5).join(", ")}${jsAssets.length > 5 ? "..." : ""}`
      );
      return false;
    }

    return this.doInject(compilation, mainAsset, mapScript);
  }

  /**
   * Actually perform the injection into an asset
   */
  private doInject(
    compilation: Compilation,
    asset: Asset,
    mapScript: string
  ): boolean {
    const { name, source } = asset;

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

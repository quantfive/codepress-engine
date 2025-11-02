import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import codepressBabelPlugin from "./index";

type NodeRequireFn = typeof require;

const SECRET = Buffer.from("codepress-file-obfuscation");

function xorEncodePath(input: string): string {
  if (!input) return "";
  const normalized = input.replace(/\\/g, "/");
  const buffer = Buffer.from(normalized, "utf8");
  const out = Buffer.allocUnsafe(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) {
    out[i] = buffer[i] ^ SECRET[i % SECRET.length];
  }
  return out
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function appendRuntimeStamp(js: string, relPath: string): string {
  try {
    const encoded = xorEncodePath(relPath || "");
    if (!encoded) return js;
    const snippet = `\n;(function(exports){\n  try {\n    if (!exports) return;\n    var globalObj = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {}));\n    var stampFn = globalObj && globalObj.__CP_stamp;\n    var registerFn = globalObj && globalObj.__CP_REGISTER__;\n    var encoded = ${JSON.stringify(encoded)};\n    var seen = Object.create(null);\n    function shouldStampName(name){\n      if (!name) return false;\n      var first = String(name).charAt(0);\n      return first && first === first.toUpperCase();\n    }\n    function applyStamp(value, exportName){\n      if (!value) return;\n      try { if (value.__cp_id) { if (typeof registerFn === 'function') { registerFn(value.__cp_id, value); } return; } } catch (_) {}\n      var id = encoded + '#' + exportName;\n      if (typeof stampFn === 'function') {\n        try { stampFn(value, id, encoded); } catch (_) {}\n      } else {\n        try { value.__cp_id = id; } catch (_) {}\n        try { value.__cp_fp = encoded; } catch (_) {}\n      }\n      if (typeof registerFn === 'function') {\n        try { registerFn(id, value); } catch (_) {}\n      }\n    }\n    if (Object.prototype.hasOwnProperty.call(exports, 'default')) {\n      applyStamp(exports.default, 'default');\n    }\n    for (var key in exports) {\n      if (!Object.prototype.hasOwnProperty.call(exports, key)) continue;\n      if (key === 'default') continue;\n      if (shouldStampName(key)) {\n        applyStamp(exports[key], key);\n      }\n    }\n  } catch (_) {}\n})(typeof module !== 'undefined' ? module.exports : undefined);\n`;
    return js + snippet;
  } catch {
    return js;
  }
}

function posixRelative(root: string, target: string): string {
  const rel = path.relative(root, target);
  return rel.replace(/\\/g, "/");
}

function determineLoader(filePath: string): "tsx" | "jsx" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsx" || ext === ".ts") return "tsx";
  return "jsx";
}

function loadFrom<T>(
  specifier: string,
  primary: NodeRequireFn,
  fallback: NodeRequireFn
): T | null {
  try {
    return primary(specifier) as T;
  } catch {
    try {
      return fallback(specifier) as T;
    } catch {
      return null;
    }
  }
}

export interface PreviewBundleModule {
  entry: string;
  js: string;
  warnings: string[];
  error?: string;
  buildError?: string;
  usedFallback?: boolean;
}

export interface PreviewBundleResult {
  modules: PreviewBundleModule[];
}

export interface PreviewBundleOptions {
  entries: string[];
  absWorkingDir: string;
  repoName?: string;
  branchName?: string;
  tsconfigPath?: string;
  quiet?: boolean;
}

export async function previewBundle(
  options: PreviewBundleOptions
): Promise<PreviewBundleResult> {
  const absWorkingDir = path.resolve(options.absWorkingDir || process.cwd());
  const createReqPath = path.join(absWorkingDir, "package.json");
  let primaryRequire: NodeRequireFn;
  try {
    primaryRequire = createRequire(createReqPath);
  } catch {
    primaryRequire = createRequire(path.join(absWorkingDir, "index.js"));
  }
  const fallbackRequire = createRequire(__filename);

  const esbuild = loadFrom<any>("esbuild", primaryRequire, fallbackRequire);
  if (!esbuild) {
    throw new Error(
      "esbuild is not available. Install it in the current repository."
    );
  }
  const babel = loadFrom<any>(
    "@babel/core",
    primaryRequire,
    fallbackRequire
  );
  if (!babel) {
    throw new Error(
      "@babel/core is required for preview bundling. Install it in the current repository."
    );
  }

  const repoName = options.repoName;
  const branchName = options.branchName;
  const tsconfigPath = options.tsconfigPath
    ? path.resolve(absWorkingDir, options.tsconfigPath)
    : (() => {
        const candidate = path.join(absWorkingDir, "tsconfig.json");
        return fsSync.existsSync(candidate) ? candidate : undefined;
      })();

  const instrumentationPlugin = {
    name: "codepress-babel-instrumentation",
    setup(build: any) {
      build.onLoad({ filter: /\.[tj]sx$/ }, async (args: { path: string }) => {
        const source = await fs.readFile(args.path, "utf8");
        const loader = determineLoader(args.path);
        try {
          const transformed = await babel.transformAsync(source, {
            filename: args.path,
            babelrc: false,
            configFile: false,
            parserOpts: {
              sourceType: "module",
              plugins: [
                "jsx",
                "typescript",
                "classProperties",
                "classPrivateProperties",
                "classPrivateMethods",
                ["decorators", { decoratorsBeforeExport: true }],
                "dynamicImport",
                "optionalChaining",
                "nullishCoalescingOperator",
              ],
            },
            assumptions: {
              constantReexports: true,
            },
            generatorOpts: {
              decoratorsBeforeExport: true,
            },
            plugins: [
              [
                codepressBabelPlugin,
                {
                  repo_name: repoName,
                  branch_name: branchName,
                },
              ],
            ],
          });
          if (transformed?.code) {
            return { contents: transformed.code, loader };
          }
        } catch (err) {
          if (!options.quiet) {
            console.warn(
              "[codepress-preview] Babel transform failed",
              err instanceof Error ? err.message : err
            );
          }
        }
        return { contents: source, loader };
      });
    },
  };

  const modules: PreviewBundleModule[] = [];

  for (const entry of options.entries) {
    const absEntry = path.resolve(absWorkingDir, entry);
    const relEntry = posixRelative(absWorkingDir, absEntry);
    let js = "";
    let warnings: string[] = [];
    let error: string | undefined;
    let buildError: string | undefined;
    let usedFallback = false;

    try {
      const buildResult = await esbuild.build({
        absWorkingDir,
        entryPoints: [absEntry],
        outfile: "codepress-preview.js",
        bundle: true,
        format: "cjs",
        platform: "browser",
        target: "es2019",
        sourcemap: "inline",
        minify: false,
        write: false,
        logLevel: "silent",
        jsx: "automatic",
        tsconfig: tsconfigPath,
        plugins: [instrumentationPlugin],
      });
      const output = buildResult.outputFiles?.[0];
      warnings = (buildResult.warnings || []).map((warning: any) =>
        warning?.text ? String(warning.text) : JSON.stringify(warning)
      );
      js = appendRuntimeStamp(output ? output.text : "", relEntry);
    } catch (err) {
      error = "build_failed";
      buildError =
        err instanceof Error && err.message ? err.message : String(err);
      try {
        const source = await fs.readFile(absEntry, "utf8");
        const loader = determineLoader(absEntry);
        const transform = await esbuild.transform(source, {
          loader,
          format: "cjs",
          jsx: "automatic",
          target: "es2019",
          sourcemap: "inline",
        });
        warnings = (transform.warnings || []).map((warning: any) =>
          warning?.text ? String(warning.text) : JSON.stringify(warning)
        );
        js = appendRuntimeStamp(transform.code, relEntry);
        usedFallback = true;
      } catch (fallbackErr) {
        if (!buildError) {
          buildError =
            fallbackErr instanceof Error && fallbackErr.message
              ? fallbackErr.message
              : String(fallbackErr);
        }
      }
    }

    modules.push({
      entry: relEntry,
      js,
      warnings,
      error,
      buildError,
      usedFallback: usedFallback || undefined,
    });
  }

  return { modules };
}

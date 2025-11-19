/**
 * CodePress esbuild plugin - Injects tracking attributes and provider wrappers into JSX
 * Replaces the Rust SWC plugin with a pure JavaScript implementation
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Plugin } from 'esbuild';

interface CodePressPluginOptions {
  repo_name?: string;
  branch_name?: string;
  repo_root?: string;
}

const SECRET = Buffer.from('codepress-file-obfuscation');

function xorEncodePath(input: string): string {
  if (!input) return '';
  const normalized = input.replace(/\\/g, '/');
  const buf = Buffer.from(normalized, 'utf8');
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ SECRET[i % SECRET.length];
  }
  return out
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Inject codepress-data-fp attributes into JSX opening tags
 */
function injectJSXAttributes(source: string, encoded: string, repoName?: string, branchName?: string): string {
  const lines = source.split('\n');
  const output: string[] = [];
  let lineNum = 0;

  for (const line of lines) {
    lineNum++;

    // Skip lines that are likely TypeScript type definitions/generics
    // These patterns indicate type syntax, not JSX
    if (
      /^\s*(interface|type|class|extends|implements)\b/.test(line) ||
      /\bextends\s+[\w.]+</.test(line) ||
      /<[\w.]+>(?!\s*[{(</])/.test(line) // Generics not followed by JSX-like syntax
    ) {
      output.push(line);
      continue;
    }

    // Match JSX opening tags with context awareness
    // Only match when < appears in typical JSX contexts (after whitespace, braces, parens, return, etc.)
    const modifiedLine = line.replace(
      /(^|\s+|[\s{(>]|return\s+|=\s*|:\s*|\?\s*)<([A-Z][\w.]*|[a-z]+)([\s\/>])/g,
      (match, before, tagName, after) => {
        // Build attributes
        const attrs: string[] = [];
        attrs.push(`codepress-data-fp="${encoded}:${lineNum}-${lineNum}"`);

        // Add repo/branch info to container elements (divs, sections, etc.)
        if (/^[a-z]/.test(tagName)) {
          if (repoName) {
            attrs.push(`codepress-github-repo-name="${repoName}"`);
          }
          if (branchName) {
            attrs.push(`codepress-github-branch="${branchName}"`);
          }
        }

        return `${before}<${tagName} ${attrs.join(' ')}${after}`;
      }
    );

    output.push(modifiedLine);
  }

  return output.join('\n');
}

/**
 * Wrap exported components with __CPProvider
 */
function wrapWithProvider(source: string): string {
  // Find default export component
  const defaultExportMatch = source.match(/export\s+default\s+function\s+(\w+)/);
  if (!defaultExportMatch) {
    // Try: export default ComponentName;
    const namedMatch = source.match(/export\s+default\s+(\w+);/);
    if (!namedMatch) return source;
  }

  const componentName = defaultExportMatch?.[1] || source.match(/export\s+default\s+(\w+);/)?.[1];
  if (!componentName) return source;

  // Inject provider wrapper code at the top
  const providerCode = `
import { useSyncExternalStore } from 'react';

// Module-level version counter for HMR
let __cpvVersion = 0;

// Provider component that wraps the default export
function __CPProvider({ value, children }: { value?: any; children: React.ReactNode }) {
  const __cpv = useSyncExternalStore(
    (cb) => {
      const h = () => {
        __cpvVersion = __cpvVersion + 1;
        cb();
      };
      if (typeof window !== 'undefined') {
        window.addEventListener("CP_PREVIEW_REFRESH", h);
        return () => { window.removeEventListener("CP_PREVIEW_REFRESH", h); };
      }
      return () => {};
    },
    () => __cpvVersion,
    () => 0
  );

  return <CPX.Provider value={value} key={__cpv}>{children}</CPX.Provider>;
}

// Context for passing data through provider
const CPX = { Provider: ({ value, children }: any) => children };
`;

  // Wrap the default export
  const wrappedSource = source.replace(
    new RegExp(`export\\s+default\\s+${componentName}`),
    `const __Original${componentName} = ${componentName};
export default function ${componentName}(props: any) {
  return <__CPProvider><__Original${componentName} {...props} /></__CPProvider>;
}`
  );

  return providerCode + '\n' + wrappedSource;
}

export function createCodePressPlugin(options: CodePressPluginOptions = {}): Plugin {
  const {
    repo_name = '',
    branch_name = '',
    repo_root = process.cwd(),
  } = options;

  return {
    name: 'codepress-jsx-transform',
    setup(build) {
      // Transform TSX/JSX files
      build.onLoad({ filter: /\.[tj]sx$/ }, async (args) => {
        try {
          // Skip node_modules
          if (args.path.includes('node_modules')) {
            return null;
          }

          const source = await fs.promises.readFile(args.path, 'utf8');
          const relPath = path.relative(repo_root, args.path);
          const encoded = xorEncodePath(relPath);

          if (!encoded) {
            return { contents: source, loader: 'tsx' };
          }

          // Step 1: Inject JSX attributes
          let transformed = injectJSXAttributes(source, encoded, repo_name, branch_name);

          // Step 2: Wrap with provider (for default exports)
          if (transformed.includes('export default')) {
            transformed = wrapWithProvider(transformed);
          }

          return {
            contents: transformed,
            loader: 'tsx',
          };
        } catch (err) {
          console.error('[CodePress Plugin] Error transforming', args.path, err);
          return null;
        }
      });
    },
  };
}

export default createCodePressPlugin;

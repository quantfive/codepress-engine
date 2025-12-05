/**
 * CodePress esbuild plugin - Injects tracking attributes into JSX
 *
 * This plugin adds codepress-data-fp attributes to JSX elements for element identification.
 * HMR is handled separately by a single root-level provider (CPRefreshProvider) that users
 * add to their app entry point, rather than wrapping every component.
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

          // Inject JSX attributes (codepress-data-fp)
          // HMR is handled by a root-level CPRefreshProvider, not per-component wrapping
          const transformed = injectJSXAttributes(source, encoded, repo_name, branch_name);

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

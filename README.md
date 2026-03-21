# CodePress Engine

[![npm version](https://img.shields.io/npm/v/@codepress/codepress-engine.svg)](https://www.npmjs.com/package/@codepress/codepress-engine)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17.0-brightgreen.svg)](https://nodejs.org)

Instrumentation engine for the [CodePress](https://codepress.dev) visual editor. Ships Babel and SWC plugins, a webpack plugin, a development server, and a CLI for React and Next.js projects.

## Installation

```bash
npm install @codepress/codepress-engine
```

## Next.js Setup

```js
// next.config.mjs
import { createSWCPlugin } from "@codepress/codepress-engine/swc";
import CodePressWebpackPlugin from "@codepress/codepress-engine/webpack-plugin";

const nextConfig = {
  experimental: {
    swcPlugins: [createSWCPlugin()],
  },
  webpack: (config, { isServer, dev }) => {
    config.plugins.push(new CodePressWebpackPlugin({ isServer, dev }));
    return config;
  },
};

export default nextConfig;
```

## Babel Setup

```js
// babel.config.mjs
export default {
  plugins: ["@codepress/codepress-engine"],
};
```

## Vite Setup

```js
// vite.config.ts
import { codepressVitePlugin } from "@codepress/codepress-engine/vite-plugin";

export default {
  plugins: [codepressVitePlugin()],
};
```

## Local Development Server

Run the CodePress dev server alongside your app for local visual editing:

```bash
npx codepress && npm start
```

See `npx codepress help` for all available commands.

## Package Exports

| Export                                       | Description                              |
| -------------------------------------------- | ---------------------------------------- |
| `@codepress/codepress-engine`               | Main entry (Babel plugin)                |
| `@codepress/codepress-engine/babel`          | Babel plugin (CommonJS)                  |
| `@codepress/codepress-engine/swc`            | SWC plugin factory & WASM helpers        |
| `@codepress/codepress-engine/webpack-plugin` | Webpack plugin for production module map |
| `@codepress/codepress-engine/vite-plugin`    | Vite plugin                              |
| `@codepress/codepress-engine/esbuild`        | esbuild plugin                           |
| `@codepress/codepress-engine/server`         | Fastify development server               |
| `@codepress/codepress-engine/cli`            | CLI (`codepress` binary)                 |

## How It Works

1. **Build time** — The Babel or SWC plugin injects `codepress-data-fp` attributes into JSX elements, encoding source file paths and line numbers
2. **Runtime** — The CodePress browser extension reads these attributes to identify source locations when you select an element
3. **Editing** — Changes flow to either the local dev server (writes to disk) or the CodePress backend (commits to GitHub)
4. **Production** — The webpack plugin creates a module map enabling hot module replacement in production builds

## Reporting Bugs

Found a bug? [Open an issue](https://github.com/quantfive/codepress-engine/issues/new?template=bug_report.yml) on this repository.

## License

Copyright (c) 2025 CodePress. All rights reserved. See [LICENSE](LICENSE) for details.

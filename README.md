## CodePress Engine

TypeScript-powered instrumentation for the CodePress visual editor. The package ships a Babel plugin, SWC plugin, development server, and CLI so React or Next.js projects can expose file-level context to the editor.

---

## Requirements

- Node.js **18.17.0 or newer** (Fastify v5 + diagnostics channel support)
- npm 8+ (or any compatible package manager)
- Git available on the host machine (repository & branch detection)

> Automated tests run under Node 16 and skip Fastify-specific assertions when the runtime lacks the required APIs. For production usage we strongly recommend Node 18+.

---

## Installation

```bash
npm install @codepress/codepress-engine
```

### Next.js usage

```js
// next.config.mjs
import { createSWCPlugin } from "@codepress/codepress-engine/swc";
import CodePressWebpackPlugin from "@codepress/codepress-engine/webpack-plugin";

const nextConfig = {
  // SWC plugin for code transformation (existing)
  experimental: {
    swcPlugins: [createSWCPlugin()],
  },

  // Webpack plugin for production module mapping (new)
  webpack: (config, { isServer, dev }) => {
    config.plugins.push(new CodePressWebpackPlugin({ isServer, dev }));
    return config;
  },
};

export default nextConfig;
```

### How it works

The plugin:

1. Automatically skips server builds (`isServer: true`) and dev builds (`dev: true`)
2. Runs during webpack compilation for production client builds
3. Builds a mapping: `{ 33: "react", 92: "react-dom", ... }`
4. Injects `window.__CP_MODULE_MAP__` into the main bundle
5. Enables O(1) module resolution instead of scanning all modules

### Bundle size impact

- Typical app (1000 modules): +3-4KB gzipped
- Large app (3000 modules): +8-10KB gzipped

### When to use

- **Required**: Production builds where you need HMR to work
- **Optional**: Development (already has named module IDs)
- **Alternative**: Set `moduleIds: 'named'` in webpack config (larger bundle, exposes file structure)

Note: When using ESM (`next.config.mjs`), prefer the named import above due to CJS interop. For CommonJS configs you can use:

```js
// next.config.cjs
const { createSWCPlugin } = require("@codepress/codepress-engine/swc");
```

The SWC plugin auto-detects your repository and branch from `git` and common CI env vars. WASM selection is automatic based on your Next.js / `@swc/core` version; see the WASM exports below for manual overrides.

Optional options for `createSWCPlugin` (all are optional; omit to use auto-detection):

| Option            | Type   | Default                         | Purpose                                            |
| ----------------- | ------ | ------------------------------- | -------------------------------------------------- |
| `repo_name`       | string | auto-detected from `git remote` | Force repository id in `owner/repo` form           |
| `branch_name`     | string | auto-detected from env/`git`    | Force branch name                                  |
| `organization_id` | string | none                            | Your CodePress organization ID (from app settings) |

---

## Babel plugin usage

```js
// babel.config.mjs
export default {
  plugins: ["@codepress/codepress-engine"],
};
```

Each JSX element receives a `codepress-data-fp` attribute whose value encodes the relative path and start/end line numbers. On the first root container (`html`, `body`, or `div`), the plugin also injects repository and branch metadata.

Optional options for the Babel plugin (all are optional; omit to use auto-detection):

| Option            | Type   | Default                         | Purpose                                            |
| ----------------- | ------ | ------------------------------- | -------------------------------------------------- |
| `repo_name`       | string | auto-detected from `git remote` | Force repository id in `owner/repo` form           |
| `branch_name`     | string | auto-detected from env/`git`    | Force branch name                                  |
| `organization_id` | string | none                            | Your CodePress organization ID (from app settings) |

Entry points exposed by the package:

| Export                                       | Description                              |
| -------------------------------------------- | ---------------------------------------- |
| `@codepress/codepress-engine/babel`          | Compiled Babel plugin (CommonJS)         |
| `@codepress/codepress-engine/swc`            | SWC plugin factory & WASM helpers        |
| `@codepress/codepress-engine/webpack-plugin` | Webpack plugin for production module map |
| `@codepress/codepress-engine/server`         | Fastify development server factory       |
| `@codepress/codepress-engine/cli`            | CLI used by the `codepress` binary       |

---

## Project layout

| Path              | Details                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `src/`            | TypeScript sources for the Babel plugin, CLI, dev server, and utils      |
| `dist/`           | Compiled JavaScript + declaration files (`npm run build`)                |
| `babel/`          | Lightweight proxy that re-exports the compiled Babel plugin              |
| `swc/`            | WASM binaries (`wasm-v42`, `wasm-v26`, `wasm-v0_82_87`) and plugin entry |
| `tests/`, `test/` | Jest suites covering Babel, SWC, and server helpers                      |

---

## Build & test workflow

```bash
# Install dependencies
npm install

# Compile TypeScript into dist/
npm run build

# Run Jest (ts-jest powered)
npm test
```

The build step must run before publishing or linking locally because Babel and CLI entry points load from `dist/`. Jest automatically performs type-checking and skips Fastify integration tests when the runtime does not support diagnostics channels.

---

## Local development

Run the local CodePress server alongside your app to visually edit code on disk (no GitHub commits):

```bash
# npm
npx codepress && npm start

# pnpm
pnpm dlx codepress && pnpm start

# yarn
yarn dlx codepress && yarn start
```

Useful commands:

```bash
# Show available commands
npx codepress help

# Launch the server explicitly on port 4321
npx codepress server

# Scaffold .env entries required by the server
npx codepress setup
```

Environment variables (from `.env` when present):

| Variable                 | Default     | Purpose                                      |
| ------------------------ | ----------- | -------------------------------------------- |
| `CODEPRESS_DEV_PORT`     | `4321`      | Fastify listen port                          |
| `CODEPRESS_BACKEND_HOST` | `localhost` | CodePress backend hostname                   |
| `CODEPRESS_BACKEND_PORT` | `8007`      | Backend REST port                            |
| `CODEPRESS_API_TOKEN`    | _unset_     | API token used for authenticated proxy calls |

The server performs git-aware writes and enriches responses with repository metadata. It writes changes to your local filesystem and is not used in production builds.

---

## SWC package exports and WASM selection

| Export                | Target                                 |
| --------------------- | -------------------------------------- |
| `./swc`               | `./dist/swc/index.js`                  |
| `./swc/wasm`          | `./swc/codepress_engine.v42.wasm`      |
| `./swc/wasm-v42`      | `./swc/codepress_engine.v42.wasm`      |
| `./swc/wasm-v26`      | `./swc/codepress_engine.v26.wasm`      |
| `./swc/wasm-v0_82_87` | `./swc/codepress_engine.v0_82_87.wasm` |

The helper automatically selects the correct WASM binary based on detected Next.js / `@swc/core` versions. Override detection with `CODEPRESS_SWC_WASM=<package specifier>` or `CODEPRESS_SWC_ABI_BAND=<v42|v26|v0_82_87>`.

---

## Feature comparison

| Capability            | Babel plugin             | SWC plugin                      |
| --------------------- | ------------------------ | ------------------------------- |
| Git-aware attributes  | ✅                       | ✅                              |
| Encoded path security | XOR + base64             | XOR + base64                    |
| Line number tracking  | ✅ start–end range       | ✅ (optional)                   |
| Performance           | Baseline                 | **20–70× faster**               |
| Output medium         | String literal attribute | `[wasmSpecifier, config]` array |

---

## Additional references

- `INSTALL.md` – linking the package locally & publishing guidance
- `MODULE_MAP_INTEGRATION.md` – detailed guide for webpack plugin integration and troubleshooting
- `scripts/build-swc.mjs` – rebuild the WASM binaries (requires Rust toolchain)
- `tests/` – examples of mocking git, fetch, and file IO when validating the plugin

---

## Contributing

PRs are welcome. Please ensure:

1. `npm run build`
2. `npm test`

are both green before submitting. Mention in the PR description if Fastify integration tests were skipped due to running on Node < 18.

CodePress Engine is released under the MIT license (see `LICENSE`).

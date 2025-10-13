# Development & Installation Guide

This document outlines the recommended workflow for working on `@quantfive/codepress-engine`, linking it locally, and preparing releases.

---

## 1. Local setup

```bash
git clone https://github.com/quantfive/codepress-engine.git
cd codepress-engine

# Install dependencies
npm install

# Compile TypeScript into dist/
npm run build

# (Optional) rebuild the SWC WASM binaries
npm run build:rust
```

The repository expects **Node 18.17.0+**. Earlier runtimes can execute most tests but will skip Fastify-specific assertions.

---

## 2. Linking into another project

1. Build the package in the repository root:
   ```bash
   npm run build
   ```
2. Expose it globally via `npm link`:
   ```bash
   npm link
   ```
3. Inside your application:
   ```bash
   npm link @quantfive/codepress-engine
   ```
4. Run your build tooling. Babel/SWC will consume the compiled plugin from `dist/`.

Whenever you make local changes, run `npm run build` again before re-running the consumer project.

---

## 3. CLI quick start

```bash
# Show commands
npx codepress help

# Generate or update .env entries
npx codepress setup

# Launch development server
npx codepress server
```

The CLI scaffolds `.env` entries (`CODEPRESS_BACKEND_HOST`, `CODEPRESS_API_TOKEN`, etc.) and runs the Fastify dev server on port `4321` by default.

---

## 4. Publishing checklist

1. Ensure the TypeScript build and tests succeed:
   ```bash
   npm run build
   npm test
   ```
2. Rebuild the SWC binaries if changes landed under `codepress-swc-plugin/`:
   ```bash
   npm run build:rust
   ```
3. Bump the version:
   ```bash
   npm version <patch|minor|major>
   ```
4. Publish to npm (ensure you are logged in and targeting the correct registry):
   ```bash
   npm publish
   ```

> The historical "build" branch flow is no longer required—the package now ships TypeScript sources and produces artifacts during `npm run build`.

---

## Troubleshooting

### Missing Fastify diagnostics channel

If you see `diagnostics.tracingChannel is not a function`, upgrade to Node 18+. The tests guard against this by skipping Fastify integration suites on unsupported runtimes.

### Local link not picking up changes

After editing sources always run `npm run build`. The Babel/SWC entry points read from `dist/`, not directly from `src/`.

### Unable to resolve SWC WASM

Set `CODEPRESS_SWC_WASM` to an explicit package export, e.g.:

```bash
CODEPRESS_SWC_WASM=@quantfive/codepress-engine/swc/wasm-v42
```

### Cleaning the environment

```bash
npm unlink @quantfive/codepress-engine
npm unlink
```

or reinstall dependencies from scratch:

```bash
rm -rf node_modules dist
npm install
npm run build
```


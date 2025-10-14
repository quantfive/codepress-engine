## CodePress Engine

TypeScript-powered instrumentation for the CodePress visual editor. The package ships a Babel plugin, SWC transform, development server, and CLI so React or Next.js projects can expose file-level context to the editor.

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

Entry points exposed by the package:

| Export                               | Description                         |
| ------------------------------------ | ----------------------------------- |
| `@codepress/codepress-engine/babel`  | Compiled Babel plugin (CommonJS)    |
| `@codepress/codepress-engine/swc`    | SWC transform loader & WASM helpers |
| `@codepress/codepress-engine/server` | Fastify development server factory  |
| `@codepress/codepress-engine/cli`    | CLI used by the `codepress` binary  |

---

## Project layout

| Path              | Details                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `src/`            | TypeScript sources for the Babel plugin, CLI, dev server, and utils         |
| `dist/`           | Compiled JavaScript + declaration files (`npm run build`)                   |
| `babel/`          | Lightweight proxy that re-exports the compiled Babel plugin                 |
| `swc/`            | WASM binaries (`wasm-v42`, `wasm-v26`, `wasm-v0_82_87`) and transform entry |
| `tests/`, `test/` | Jest suites covering Babel, SWC, and server helpers                         |

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

## CLI & development server

```bash
# Show available commands
npx codepress help

# Launch the Fastify dev server on port 4321
npx codepress server

# Scaffold .env entries and install prettiers required by the dev server
npx codepress setup

# Run your own command with the dev server in the background
npx codepress npm start
```

Environment variables (loaded from `.env` when present):

| Variable                 | Default     | Purpose                                      |
| ------------------------ | ----------- | -------------------------------------------- |
| `CODEPRESS_DEV_PORT`     | `4321`      | Fastify listen port                          |
| `CODEPRESS_BACKEND_HOST` | `localhost` | CodePress backend hostname                   |
| `CODEPRESS_BACKEND_PORT` | `8007`      | Backend REST port                            |
| `CODEPRESS_API_TOKEN`    | _unset_     | API token used for authenticated proxy calls |

The server performs git-aware writes, forwards requests to the CodePress backend, and enriches responses with repository metadata. It never runs in production builds.

---

## Babel plugin usage

```js
// babel.config.js
module.exports = {
  plugins: [
    [
      "@codepress/codepress-engine",
      {
        attributeName: "codepress-data-fp",
        repoAttributeName: "codepress-github-repo-name",
        branchAttributeName: "codepress-github-branch",
      },
    ],
  ],
};
```

Each JSX element receives a `codepress-data-fp` attribute whose value encodes the relative path and start/end line numbers. Repository and branch metadata are attached to container elements (`html`, `body`, `div`) to help the visual editor route updates.

---

## SWC transform usage

```js
const {
  transformWithCodePress,
} = require("@codepress/codepress-engine/swc-plugin");

async function transform(source, filePath) {
  const result = await transformWithCodePress(source, filePath, {
    attributeName: "codepress-data-fp",
    repoAttributeName: "codepress-github-repo-name",
    branchAttributeName: "codepress-github-branch",
  });

  return result.code;
}
```

`package.json` exports:

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

| Capability            | Babel plugin             | SWC transform                   |
| --------------------- | ------------------------ | ------------------------------- |
| Git-aware attributes  | ✅                       | ✅                              |
| Encoded path security | XOR + base64             | XOR + base64                    |
| Line number tracking  | ✅ start–end range       | ✅ (optional)                   |
| Performance           | Baseline                 | **20–70× faster**               |
| Output medium         | String literal attribute | `[wasmSpecifier, config]` array |

---

## Additional references

- `INSTALL.md` – linking the package locally & publishing guidance
- `scripts/build-swc.mjs` – rebuild the WASM binaries (requires Rust toolchain)
- `tests/` – examples of mocking git, fetch, and file IO when validating the plugin

---

## Contributing

PRs are welcome. Please ensure:

1. `npm run build`
2. `npm test`

are both green before submitting. Mention in the PR description if Fastify integration tests were skipped due to running on Node < 18.

CodePress Engine is released under the MIT license (see `LICENSE`).

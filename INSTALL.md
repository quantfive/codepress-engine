# Installation Guide

This package uses a **build branch** approach to keep the main branch clean. All build artifacts (compiled WASM, transpiled JS) are automatically built and deployed to the `build` branch.

## For Team Members (GitHub Install)

### Install from Build Branch

```bash
# Install the latest build from GitHub
npm install github:quantfive/codepress-engine#build

# Or with yarn
yarn add github:quantfive/codepress-engine#build

# Alternative shorthand syntax
npm install quantfive/codepress-engine#build
```

### Local Development Setup

```bash
# Clone and set up for local development
git clone https://github.com/quantfive/codepress-engine.git
cd codepress-engine

# Install dependencies
npm install

# Build everything locally (creates dist/ and swc/ folders)
npm run dev:link

# Link for local testing
# (This runs build + build:rust + npm link)
```

## For End Users (NPM Install)

Once published to npm:

```bash
npm install @quantfive/codepress-engine
```

## Usage

### Next.js (SWC Plugin)

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    swcPlugins: [["@quantfive/codepress-engine/swc", {}]],
  },
};

module.exports = nextConfig;
```

### Babel Plugin

```javascript
// babel.config.js
module.exports = {
  plugins: [["@quantfive/codepress-engine/babel", {}]],
};
```

## Development Workflow

### Main Branch

- ✅ Source code only
- ✅ Clean PRs without build artifacts
- ✅ Easy to review changes

### Build Branch (Auto-updated)

- ✅ Contains all build artifacts
- ✅ Ready-to-use package
- ✅ Updated automatically on every push to main

### Local Testing

```bash
# Make changes to source code
# Then rebuild and test locally:
npm run dev:link

# In your test project:
npm link @quantfive/codepress-engine
```

## Branch Structure

```
main branch (source code)
├── src/           (JavaScript source)
├── babel/         (Babel plugin source)
├── codepress-swc-plugin/  (Rust source)
├── tests/         (Test files)
└── package.json

build branch (artifacts) - Auto-generated
├── dist/          (Built JavaScript)
├── babel/         (Babel plugin)
├── swc/           (Built WASM)
├── examples/      (Usage examples)
└── package.json
```

## Troubleshooting

### "Module not found" Error

Make sure you're installing from the `build` branch:

```bash
npm install github:quantfive/codepress-engine#build
```

### Local Development Issues

If local linking isn't working:

```bash
# Rebuild everything
npm run dev:link

# Check what's linked globally
npm list -g --depth=0 | grep codepress
```

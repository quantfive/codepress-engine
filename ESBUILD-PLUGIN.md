# CodePress esbuild Plugin

## Overview

This replaces the Rust SWC WASM plugin with a pure TypeScript esbuild plugin that's easier to maintain and debug.

## What It Does

The plugin transforms JSX/TSX files to add CodePress tracking attributes:

### 1. JSX Attribute Injection
```tsx
// Input
<div className="container">
  <Button onClick={handleClick}>Click</Button>
</div>

// Output
<div codepress-data-fp="ENCODED_PATH:10-10" codepress-github-repo-name="org/repo" codepress-github-branch="main" className="container">
  <Button codepress-data-fp="ENCODED_PATH:11-11" onClick={handleClick}>Click</Button>
</div>
```

### 2. Provider Wrapper (Coming Soon)
```tsx
// Wraps default exports with __CPProvider for HMR
export default function MyComponent() {
  return <div>Content</div>;
}

// Becomes
export default function MyComponent(props) {
  return <__CPProvider><__OriginalMyComponent {...props} /></__CPProvider>;
}
```

### 3. File Path Encoding
- Uses XOR encryption with base64 encoding
- Same SECRET as the Rust plugin: `'codepress-file-obfuscation'`
- URL-safe: replaces `+` with `-`, `/` with `_`, removes `=`

## Usage

### In Backend (Python)

```python
# The backend Node script will automatically load it:
createCodePressPlugin = require('@codepress/codepress-engine/esbuild').createCodePressPlugin;

const plugin = createCodePressPlugin({
  repo_name: 'org/repo',
  branch_name: 'main',
  repo_root: '/path/to/repo'
});

// Use with esbuild
await esbuild.build({
  ...options,
  plugins: [plugin]
});
```

### In JavaScript/TypeScript

```typescript
import { createCodePressPlugin } from '@codepress/codepress-engine/esbuild';

const plugin = createCodePressPlugin({
  repo_name: 'myorg/myrepo',
  branch_name: 'main',
  repo_root: process.cwd()
});
```

## Package Export

Added to `package.json`:
```json
{
  "exports": {
    "./esbuild": {
      "types": "./dist/esbuild-plugin.d.ts",
      "require": "./dist/esbuild-plugin.js",
      "default": "./dist/esbuild-plugin.js"
    }
  }
}
```

## Benefits Over SWC Plugin

✅ **No WASM** - Pure JavaScript, no compilation needed
✅ **Easier to debug** - Can console.log, use Node debugger
✅ **Faster development** - No Rust rebuild cycle
✅ **More maintainable** - TypeScript vs Rust
✅ **Environment agnostic** - Works anywhere Node.js runs

## Implementation Details

### Files
- `src/esbuild-plugin.ts` - Main plugin implementation
- `dist/esbuild-plugin.js` - Compiled output
- `dist/esbuild-plugin.d.ts` - TypeScript definitions

### Key Functions
- `xorEncodePath()` - Encodes file paths
- `injectJSXAttributes()` - Adds attributes to JSX tags
- `wrapWithProvider()` - Wraps components with HMR provider
- `createCodePressPlugin()` - Main plugin factory

## Next Steps

1. **Push to GitHub**: Trigger CI to build and publish
2. **Backend will auto-use**: Already configured in `router.py`
3. **Test**: Preview modules should have `codepress-data-fp` attributes

## Deployment

```bash
# Version bump
cd codepress-engine
npm version patch  # or minor/major

# Push (CI will build and publish)
git add .
git commit -m "feat: Add esbuild plugin for JSX stamping"
git push origin main
git push --tags
```

## Fallback Behavior

If the plugin isn't available, the backend falls back to inline regex-based stamping with the same functionality but without provider wrapping.

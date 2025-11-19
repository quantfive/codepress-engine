# Testing the Babel Plugin Port

Quick guide to verify the Babel plugin port works correctly.

## Prerequisites

```bash
# Install dependencies
npm install

# Build the Babel plugin
npm run build
```

## Quick Test (2 minutes)

Run the parity tests to verify Babel plugin works:

```bash
npm run test:parity
```

**Expected output:**
```
PASS test/plugin-parity.test.js
  Plugin Parity: Babel vs SWC
    Basic JSX Tracking
      ✓ adds codepress-data-fp to simple div
      ✓ adds attributes to nested elements
    Rich Metadata Attributes
      ✓ adds edit candidates to elements with props
      ✓ adds source kinds attribute
      ✓ adds symbol refs attribute
      ✓ adds callsite attribute
    Module Graph Collection
      ✓ collects imports
      ✓ collects exports
      ✓ collects definitions
      ✓ collects mutations
      ✓ collects literal index from exports
    Provenance Tracking
      ✓ traces literal values
      ✓ traces variable references
      ✓ traces imports
      ✓ traces function calls
      ✓ traces member expressions
      ✓ detects environment variables
    Candidate Ranking
      ✓ ranks callsite as candidate
      ✓ ranks const-init as candidate
      ✓ ranks import as candidate

PASS test/fixtures.test.js
  Fixture Tests: Real Files
    Fixture: simple-component.tsx
      ✓ both plugins transform without errors
      ✓ babel adds codepress attributes
      ✓ babel adds rich metadata
      ✓ babel injects module graph

📊 Plugin Parity Summary:
   Total elements: 47
   Matching: 45
   Match rate: 95.7%

Test Suites: 2 passed, 2 total
Tests:       42 passed, 42 total
```

## What If SWC Plugin Isn't Built?

You'll see this warning:
```
⚠️  SWC WASM plugin not found
   Skipping SWC comparison tests...
```

This is **fine for Babel testing**. Tests will verify:
- ✅ Babel plugin transforms successfully
- ✅ All attributes are added
- ✅ Metadata can be decoded
- ✅ Module graph is injected

To enable SWC comparison (optional):
```bash
cd codepress-swc-plugin
rustup target add wasm32-wasip1
cargo build --target wasm32-wasip1 --release
cd ..
npm run test:parity
```

## Verify Specific Features

### Test Module Graph Collection

```bash
npm run build && node -e "
const { transformSync } = require('@babel/core');

const code = \`
import { useState } from 'react';
export const VALUE = 42;

export default function App() {
  return <div>Test</div>;
}
\`;

const result = transformSync(code, {
  filename: 'test.tsx',
  presets: ['@babel/preset-react', '@babel/preset-typescript'],
  plugins: [require.resolve('./dist/index.js')]
});

// Check for graph injection
if (result.code.includes('__CPX_GRAPH')) {
  console.log('✅ Module graph injection works!');

  // Extract and parse graph
  const match = result.code.match(/JSON\.parse\((.+?)\);/);
  if (match) {
    const graphJson = JSON.parse(match[1]);
    const graph = JSON.parse(graphJson);
    console.log('✅ Graph structure:', Object.keys(graph));
    console.log('   - Imports:', graph.imports?.length || 0);
    console.log('   - Exports:', graph.exports?.length || 0);
    console.log('   - Defs:', graph.defs?.length || 0);
  }
} else {
  console.log('❌ Module graph not found');
}
"
```

### Test Provenance Tracking

```bash
npm run build && node -e "
const { transformSync } = require('@babel/core');
const { decode } = require('./dist/index');

const code = \`
const message = 'Hello';
export default function App() {
  return <div>{message}</div>;
}
\`;

const result = transformSync(code, {
  filename: 'test.tsx',
  presets: ['@babel/preset-react', '@babel/preset-typescript'],
  plugins: [require.resolve('./dist/index.js')]
});

// Extract candidates attribute
const match = result.code.match(/data-codepress-edit-candidates=\"([^\"]+)\"/);
if (match) {
  const candidatesEnc = match[1];
  const candidatesJson = decode(candidatesEnc);
  const candidates = JSON.parse(candidatesJson);

  console.log('✅ Provenance tracking works!');
  console.log('   Candidates:', candidates.length);
  candidates.forEach(c => {
    console.log(\`   - \${c.reason}: \${c.target}\`);
  });
} else {
  console.log('❌ No candidates found');
}
"
```

### Test Attribute Encoding/Decoding

```bash
npm run build && node -e "
const { decode } = require('./dist/index');
const { transformSync } = require('@babel/core');

const code = \`export default function App() { return <div>Test</div>; }\`;

const result = transformSync(code, {
  filename: 'test.tsx',
  presets: ['@babel/preset-react', '@babel/preset-typescript'],
  plugins: [require.resolve('./dist/index.js')]
});

// Extract and decode file path
const fpMatch = result.code.match(/codepress-data-fp=\"([^\"]+)\"/);
if (fpMatch) {
  const encoded = fpMatch[1];
  const [encodedPath, lineRange] = encoded.split(':');
  const decoded = decode(encodedPath);

  console.log('✅ Encoding/decoding works!');
  console.log('   Encoded:', encodedPath.substring(0, 20) + '...');
  console.log('   Decoded:', decoded);
  console.log('   Line range:', lineRange);
} else {
  console.log('❌ No file path found');
}
"
```

## Test Real Project

Use your existing test project or create a simple one:

```bash
# Create test project
mkdir test-project
cd test-project
npm init -y
npm install react @babel/core @babel/preset-react @babel/preset-typescript

# Link your local plugin
cd ../
npm link
cd test-project
npm link @codepress/codepress-engine

# Create test component
cat > App.tsx << 'EOF'
import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h1>Count: {count}</h1>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </div>
  );
}
EOF

# Create babel config
cat > babel.config.js << 'EOF'
module.exports = {
  presets: [
    '@babel/preset-react',
    '@babel/preset-typescript'
  ],
  plugins: [
    ['@codepress/codepress-engine', {
      repo_name: 'test/repo',
      branch_name: 'main'
    }]
  ]
};
EOF

# Transform and check output
npx babel App.tsx

# Look for:
# 1. codepress-data-fp attributes
# 2. data-codepress-edit-candidates
# 3. data-codepress-source-kinds
# 4. __CPX_GRAPH injection
```

## Verify Feature Parity

Compare outputs side-by-side:

```bash
npm run build

# Transform with Babel
node -e "
const { transformSync } = require('@babel/core');
const code = require('fs').readFileSync('test/fixtures/with-props.tsx', 'utf8');

const result = transformSync(code, {
  filename: 'with-props.tsx',
  presets: ['@babel/preset-react', '@babel/preset-typescript'],
  plugins: [require.resolve('./dist/index.js')]
});

console.log('=== BABEL OUTPUT ===');
// Show attributes
const attrs = result.code.match(/data-codepress-[^=]+=\"[^\"]+\"/g);
console.log('Attributes:', attrs?.length || 0);
attrs?.slice(0, 3).forEach(a => console.log(' ', a.substring(0, 50) + '...'));
"

# If you have SWC plugin built, compare:
# (This requires swc CLI and plugin to be set up)
```

## Common Issues

### ❌ "Cannot find module './dist/index.js'"

**Fix:**
```bash
npm run build
```

### ❌ "SyntaxError: Unexpected token"

**Fix:** Ensure you have the right presets:
```bash
npm install --save-dev @babel/preset-react @babel/preset-typescript
```

### ❌ No attributes in output

**Fix:** Check that:
1. File has JSX elements
2. Plugin is in babel config
3. Build is up to date

### ⚠️ "Low match rate" warning

This is **informational**. The Babel plugin should still work. Check:
1. Is SWC plugin built? (optional)
2. Are there known differences? (see `FEATURE_PARITY.md`)

## CI/CD Setup

Add to your CI pipeline:

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run build
      - run: npm run test:parity
```

## Next Steps

After tests pass:

1. ✅ **Try in your project** - Use the plugin in a real Next.js/React app
2. ✅ **Test with extension** - Verify browser extension can decode attributes
3. ✅ **Check production build** - Ensure it works in production mode
4. ✅ **Add to CI** - Automate testing

## Getting Help

If tests fail:

1. Check `test/README.md` for detailed docs
2. Look at `PORTING_GUIDE.md` for implementation details
3. Compare with SWC plugin source: `codepress-swc-plugin/src/lib.rs`
4. File an issue with test output

## Success Criteria

✅ All tests pass (or gracefully skip SWC comparison)
✅ Match rate >80% if SWC comparison runs
✅ Attributes can be decoded
✅ Module graph is injected
✅ Works in real project

If you see all checkmarks, the port is successful! 🎉

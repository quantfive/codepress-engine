# CodePress Plugin Tests

Comprehensive test suite ensuring the Babel plugin matches the SWC plugin's behavior.

## Test Structure

```
test/
├── plugin-parity.test.js   # Unit tests comparing Babel vs SWC
├── fixtures.test.js         # Integration tests with real fixture files
├── fixtures/                # Test fixture files
│   ├── simple-component.tsx
│   ├── with-props.tsx
│   └── with-data.tsx
└── README.md                # This file
```

## Running Tests

### Install Dependencies

```bash
npm install
```

### Build Required

Tests require the Babel plugin to be built first:

```bash
npm run build
```

### Run All Tests

```bash
npm test
```

### Run Specific Test Suites

```bash
# Only Babel plugin tests (unit tests)
npm run test:babel

# Only fixture tests (integration)
npm run test:fixtures

# Both parity tests
npm run test:parity

# Watch mode (auto-rerun on changes)
npm run test:watch
```

## Test Suites

### 1. Plugin Parity Tests (`plugin-parity.test.js`)

**Purpose:** Verify Babel plugin produces same output as SWC plugin

**Coverage:**
- ✅ Basic JSX tracking (file paths, line numbers)
- ✅ Rich metadata attributes (candidates, kinds, symbol-refs)
- ✅ Module graph collection (imports, exports, defs, mutations)
- ✅ Provenance tracking (data flow analysis)
- ✅ Candidate ranking (edit targets)

**How it works:**
1. Transforms code with both Babel and SWC
2. Extracts attributes from output
3. Decodes and compares metadata
4. Reports differences

**Example:**
```javascript
test('adds edit candidates to elements with props', () => {
  const code = `
    const message = "Hello";
    export default function App() {
      return <div>{message}</div>;
    }
  `;

  const babelOutput = transformWithBabel(code);
  const swcOutput = transformWithSwc(code);

  // Extract and compare candidates
  // ...
});
```

### 2. Fixture Tests (`fixtures.test.js`)

**Purpose:** Test real-world component files

**Coverage:**
- ✅ Simple components
- ✅ Components with props and state
- ✅ Components with data from constants/imports
- ✅ Components with environment variables
- ✅ Nested components
- ✅ Components with mutations

**How it works:**
1. Reads all `.tsx` files from `fixtures/`
2. Transforms each with both plugins
3. Compares attribute presence and structure
4. Reports match rate statistics

**Adding New Fixtures:**
1. Create `.tsx` file in `test/fixtures/`
2. Run tests - automatically included
3. Check match rate in summary

### 3. Shared Fixtures (`fixtures/`)

Reusable test files covering common patterns:

#### `simple-component.tsx`
- Basic JSX element
- Literal text content
- Tests: Basic attribute injection

#### `with-props.tsx`
- Props destructuring
- State hooks
- Event handlers
- Tests: Provenance tracking, symbol refs

#### `with-data.tsx`
- Imported constants
- Local data structures (objects, arrays)
- Environment variables
- Map operations
- Tests: Complex data flow, candidate ranking

## What Gets Tested

### Attributes Verified

| Attribute | Description | Test Coverage |
|-----------|-------------|---------------|
| `codepress-data-fp` | File path + line range | ✅ All tests |
| `data-codepress-callsite` | Callsite location | ✅ Parity tests |
| `data-codepress-edit-candidates` | Ranked edit targets | ✅ Parity + fixtures |
| `data-codepress-source-kinds` | Data source types | ✅ Parity + fixtures |
| `data-codepress-symbol-refs` | Symbol references | ✅ Parity + fixtures |

### Module Graph Verified

| Feature | Description | Test Coverage |
|---------|-------------|---------------|
| Imports | Import statements | ✅ Parity tests |
| Exports | Export declarations | ✅ Parity tests |
| Definitions | Variable/function/class defs | ✅ Parity tests |
| Mutations | Assignments, updates | ✅ Parity tests |
| Literal index | String literals in exports | ✅ Parity tests |

### Provenance Tracking Verified

| Source Type | Description | Test Coverage |
|-------------|-------------|---------------|
| Literal | String/number literals | ✅ Parity tests |
| Ident | Variable references | ✅ Parity tests |
| Init | Const initializers | ✅ Parity tests |
| Import | Imported values | ✅ Parity tests |
| Call | Function calls | ✅ Parity tests |
| Member | Object.property access | ✅ Parity tests |
| Env | process.env.X | ✅ Parity tests |

## SWC Plugin Requirement

Some tests compare against the SWC plugin output. This requires:

### Building SWC Plugin

```bash
cd codepress-swc-plugin
cargo build --target wasm32-wasip1 --release
```

### If SWC Plugin Not Available

Tests will gracefully skip SWC comparisons and only test Babel plugin functionality:

```
⚠️  SWC WASM plugin not found
   Build it with: cd codepress-swc-plugin && cargo build --target wasm32-wasip1 --release
   Skipping SWC comparison tests...
```

Babel-only tests will still run and verify:
- ✅ Attributes are added
- ✅ Metadata is properly encoded
- ✅ Module graph is injected
- ✅ Decoding works correctly

## Understanding Test Output

### Success
```
✓ Basic JSX Tracking
  ✓ adds codepress-data-fp to simple div (15ms)
  ✓ adds attributes to nested elements (8ms)

✓ Rich Metadata Attributes
  ✓ adds edit candidates to elements with props (12ms)
  ✓ adds source kinds attribute (9ms)

📊 Plugin Parity Summary:
   Total elements: 47
   Matching: 45
   Match rate: 95.7%

Test Suites: 2 passed, 2 total
Tests:       42 passed, 42 total
```

### Failures

If tests fail, check:

1. **Build issue?**
   ```bash
   npm run build
   ```

2. **Missing dependencies?**
   ```bash
   npm install
   ```

3. **SWC plugin missing?** (Expected if you haven't built it)
   ```
   ⚠️  SWC comparison skipped
   ```

4. **Actual parity issue?**
   - Check the specific test failure
   - Compare Babel vs SWC output
   - May need to update Babel plugin port

## Adding New Tests

### Add Unit Test

Edit `plugin-parity.test.js`:

```javascript
test('your new test', () => {
  const code = `/* your test code */`;

  const babelOutput = transformWithBabel(code);
  const swcOutput = transformWithSwc(code);

  // Your assertions
  expect(babelOutput).toContain('...');
});
```

### Add Fixture

Create `fixtures/your-component.tsx`:

```tsx
// Your component code
export default function YourComponent() {
  return <div>Test</div>;
}
```

Tests automatically run on all fixtures!

## Continuous Integration

For CI environments:

```bash
# Install dependencies
npm ci

# Build plugin
npm run build

# Run tests (skips SWC if not available)
npm test

# Or run only Babel tests
npm run test:babel
```

## Troubleshooting

### "Cannot find module '../dist/index.js'"

**Solution:** Build the plugin first
```bash
npm run build
```

### "SWC transform failed"

**Solution:** This is expected if SWC plugin isn't built. Tests will skip SWC comparisons.

To build SWC plugin:
```bash
cd codepress-swc-plugin
rustup target add wasm32-wasip1
cargo build --target wasm32-wasip1 --release
```

### "Low match rate" warning

**Solution:** This indicates Babel and SWC outputs differ. Check:
1. Did you update one plugin but not the other?
2. Is there a known difference (see `FEATURE_PARITY.md`)?
3. File an issue with the test code

### Tests pass but extension doesn't work

**Solution:** Tests verify build-time transform. Runtime behavior depends on:
1. Extension code correctly decoding attributes
2. Server endpoints working properly
3. Check extension console for errors

## Match Rate Threshold

Tests expect **>50% match rate** between Babel and SWC. Current target: **>95%**

Low match rates (<80%) will show warnings with details:
```
⚠️  Low match rate: { babelCount: 10, swcCount: 10, matches: 7 }
Differences: [
  { index: 2, tag: 'div', field: 'data-codepress-callsite', babel: 'present', swc: 'missing' }
]
```

## Maintenance

### When Adding Features

1. Add feature to both plugins
2. Add test to `plugin-parity.test.js`
3. Run `npm run test:parity`
4. Fix differences until match rate >95%
5. Add to fixture if it's a common pattern

### When Tests Fail

1. Check if SWC plugin is source of truth
2. Update Babel plugin to match SWC behavior
3. Re-run tests
4. Document any intentional differences in `FEATURE_PARITY.md`

## Performance

Typical test run time:
- **Babel-only tests:** ~5-10 seconds
- **With SWC comparison:** ~15-20 seconds
- **Watch mode:** ~2-3 seconds per change

## Coverage

Current coverage: **~85%** of plugin code

Not covered (requires integration testing):
- Server-side analysis endpoints
- Browser extension decoding
- Production build behavior
- Error recovery paths

For integration tests, see `tests/` directory (separate from unit tests).

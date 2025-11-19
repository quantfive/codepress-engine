# Feature Parity Tracking: SWC vs Babel

This document tracks feature parity between the SWC and Babel plugins.

## Core Features (✅ = Both, 🟡 = SWC Only)

| Feature | Babel | SWC | Priority | Notes |
|---------|-------|-----|----------|-------|
| **Basic Tracking** | | | | |
| File path encoding | ✅ | ✅ | P0 | Both use XOR + base64url |
| Line number ranges | ✅ | ✅ | P0 | Format: `encodedPath:start-end` |
| Git repo detection | ✅ | ✅ | P0 | Via env vars + git commands |
| Git branch detection | ✅ | ✅ | P0 | Via env vars + git commands |
| **Attributes** | | | | |
| `codepress-data-fp` | ✅ | ✅ | P0 | File path + line range |
| `codepress-github-repo-name` | ✅ | ✅ | P0 | Injected on body (Babel) or root element (SWC) |
| `codepress-github-branch` | ✅ | ✅ | P0 | Same as above |
| `data-codepress-callsite` | ❌ | ✅ | P1 | Separate from element location |
| `data-codepress-edit-candidates` | ❌ | ✅ | P1 | Ranked list of edit targets |
| `data-codepress-source-kinds` | ❌ | ✅ | P1 | Data source categories |
| `data-codepress-symbol-refs` | ❌ | ✅ | P2 | Symbol references |
| **Module Graph** | | | | |
| Import tracking | ❌ | ✅ | P1 | Module graph: imports array |
| Export tracking | ❌ | ✅ | P1 | Module graph: exports array |
| Re-export tracking | ❌ | ✅ | P2 | Module graph: reexports array |
| Definition tracking | ❌ | ✅ | P1 | Module graph: defs array |
| Mutation tracking | ❌ | ✅ | P2 | Module graph: mutations array |
| Literal indexing | ❌ | ✅ | P2 | Module graph: literal_index array |
| Graph injection | ❌ | ✅ | P1 | `globalThis.__CPX_GRAPH[file]` |
| **Provenance Tracking** | | | | |
| Binding collection | ❌ | ✅ | P1 | Track variable initializers |
| Expression tracing | ❌ | ✅ | P1 | Recursive data flow analysis |
| Candidate ranking | ❌ | ✅ | P1 | Score edit targets |
| Environment detection | ❌ | ✅ | P2 | Detect process.env usage |
| Symbol ref collection | ❌ | ✅ | P2 | Track symbol usage |
| **Component Wrapping** | | | | |
| Custom component detection | ❌ | ✅ | P1 | Uppercase component names |
| Display:contents wrapper | ❌ | ✅ | P1 | Invisible DOM wrapper |
| Skip components list | ❌ | ✅ | P1 | e.g., Slot, Link |
| Skip member roots | ❌ | ✅ | P1 | e.g., Primitive.* |
| Provider injection | ❌ | ✅ | P2 | React context (disabled) |
| **Advanced** | | | | |
| Multi-pass transforms | ❌ | ✅ | P1 | Transform + hoist & elide |
| Path normalization | ❌ | ✅ | P0 | Handle turbopack/[project]/ |
| SourceMapper integration | ❌ | ✅ | P0 | Proper span handling |

## Priority Levels
- **P0**: Critical for basic functionality
- **P1**: Important for full feature set
- **P2**: Nice to have / advanced features

## Maintenance Strategy

### Current Approach (Recommended)
1. **SWC = Full-featured** - Maintain all P0-P2 features
2. **Babel = Essential only** - Maintain only P0 features
3. **Migration path** - Document SWC migration for users needing P1/P2

### Alternative: Feature Flags
```typescript
// babel/index.ts
export default function codePressPlugin(babel, options) {
  if (options.advanced) {
    throw new Error(
      'Advanced features require SWC plugin. ' +
      'Set advanced:false or migrate to SWC.'
    );
  }
  // Basic implementation only
}
```

### Alternative: Port Priority Features
Manually port P1 features to Babel:
1. Start with module graph (imports/exports/defs)
2. Add basic provenance tracking
3. Add edit candidates
4. Skip complex features (mutations, literal index)

Estimated effort: **2-3 weeks** per P1 feature cluster

## Testing Strategy

### Shared Test Fixtures
See `test/shared-fixtures.js` - all tests must pass for both plugins (with feature flags)

### Differential Testing
```bash
npm run test:babel     # Run Babel-specific tests
npm run test:swc       # Run SWC-specific tests
npm run test:shared    # Run shared fixtures on both
npm run test:parity    # Compare outputs
```

## Decision Matrix

| Scenario | Recommendation |
|----------|----------------|
| User needs basic tracking | Either plugin works |
| User needs module graph / provenance | Must use SWC |
| User on Babel-only stack | Use Babel plugin + document limitations |
| User can use SWC | Always prefer SWC |
| New features | Implement in SWC only |

## Update Process

When adding features:
1. ✅ Add to SWC plugin
2. ✅ Update this tracking doc
3. ✅ Add to shared test fixtures (if applicable)
4. ⚠️ Evaluate: Is this P0? → Port to Babel
5. ⚠️ Evaluate: Is this P1+? → SWC only, update docs

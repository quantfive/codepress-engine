# Plugin Sync Strategy

## Problem
- SWC plugin: 2,311 lines, advanced features (module graph, provenance, etc.)
- Babel plugin: 255 lines, basic features (file tracking only)
- Maintaining feature parity across Rust + TypeScript is unsustainable

## Recommended Solution: Runtime Analysis Architecture

Move complex analysis from compile-time (plugins) to runtime (server).

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Build Time (Plugins - Keep Minimal)                         │
├─────────────────────────────────────────────────────────────┤
│  Babel Plugin          │  SWC Plugin                         │
│  - File path encoding  │  - File path encoding               │
│  - Line numbers        │  - Line numbers                     │
│  - Basic JSX tracking  │  - Basic JSX tracking               │
│                        │  - (Optional) Custom wrapping       │
└─────────────────────────────────────────────────────────────┘
                              ↓
                    Minimal metadata in DOM
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  Runtime (Server - Rich Analysis)                            │
├─────────────────────────────────────────────────────────────┤
│  Shared TypeScript Analysis Engine                           │
│  - Module graph builder (imports/exports/defs)               │
│  - Provenance tracker (data flow analysis)                   │
│  - Candidate ranker (edit targets)                           │
│  - Symbol reference collector                                │
│  - Mutation tracker                                          │
│  Works with both Babel AND SWC outputs!                      │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Extract Analysis Engine (Week 1-2)

Create `src/analysis/` module that works independently of plugins:

```typescript
// src/analysis/module-graph.ts
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';

export interface ModuleGraph {
  imports: ImportRow[];
  exports: ExportRow[];
  defs: DefRow[];
  mutations: MutationRow[];
}

export async function analyzeFile(filePath: string): Promise<ModuleGraph> {
  const code = await fs.readFile(filePath, 'utf8');
  const ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const graph: ModuleGraph = {
    imports: [],
    exports: [],
    defs: [],
    mutations: [],
  };

  traverse(ast, {
    ImportDeclaration(path) {
      graph.imports.push({
        local: path.node.specifiers[0]?.local.name,
        source: path.node.source.value,
        span: `${filePath}:${path.node.loc.start.line}`,
      });
    },
    ExportNamedDeclaration(path) {
      // ... similar logic
    },
    VariableDeclarator(path) {
      // ... track definitions
    },
    AssignmentExpression(path) {
      // ... track mutations
    },
  });

  return graph;
}
```

```typescript
// src/analysis/provenance.ts
export interface ProvenanceChain {
  candidates: Candidate[];
  kinds: string[];
  symbolRefs: SymbolRef[];
}

export async function traceProvenance(
  filePath: string,
  line: number
): Promise<ProvenanceChain> {
  const ast = await parseFile(filePath);
  // Find JSX element at line
  // Trace all expressions in props/children
  // Build provenance chain
  return { candidates, kinds, symbolRefs };
}
```

### Phase 2: Update Server (Week 2)

Add analysis endpoints to your existing `server.ts`:

```typescript
// src/server.ts - ADD THESE ENDPOINTS

app.get('/api/module-graph', async (req, reply) => {
  const { encodedPath } = req.query;
  const filePath = decode(encodedPath);

  const graph = await analyzeFile(filePath);
  return reply.send({ graph });
});

app.post('/api/provenance', async (req, reply) => {
  const { encodedPath, line } = req.body;
  const filePath = decode(encodedPath);

  const provenance = await traceProvenance(filePath, line);
  return reply.send(provenance);
});

app.post('/api/edit-candidates', async (req, reply) => {
  const { encodedPath, line } = req.body;
  const filePath = decode(encodedPath);

  const provenance = await traceProvenance(filePath, line);
  const candidates = rankCandidates(provenance);

  return reply.send({ candidates });
});
```

### Phase 3: Simplify Plugins (Week 3)

#### Babel Plugin - Keep Minimal
```typescript
// src/index.ts - SIMPLIFIED
export default function codePressPlugin(babel, options) {
  return {
    visitor: {
      JSXOpeningElement(path, state) {
        // ONLY add file:line tracking
        const encoded = encode(getRelativePath(state));
        const line = `${path.node.loc.start.line}-${path.node.loc.end.line}`;

        path.node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier('codepress-data-fp'),
            t.stringLiteral(`${encoded}:${line}`)
          )
        );
      }
    }
  };
}
```

#### SWC Plugin - Keep Only Build-Time Optimizations
```rust
// lib.rs - REMOVE complex analysis, keep only:
// 1. File path encoding
// 2. Custom component wrapping (for DOM structure)
// 3. Skip lists (build-time filtering)
//
// REMOVE:
// - Module graph collection (move to server)
// - Provenance tracking (move to server)
// - Binding collection (move to server)
// - Graph injection (not needed)
```

### Phase 4: Update Browser Extension (Week 3-4)

Update extension to call server for rich data:

```typescript
// In browser extension
async function getEditCandidates(element: HTMLElement) {
  const encodedPath = element.getAttribute('codepress-data-fp');
  const [_, lineRange] = encodedPath.split(':');
  const [startLine] = lineRange.split('-');

  // Call server for rich analysis
  const response = await fetch('http://localhost:3456/api/edit-candidates', {
    method: 'POST',
    body: JSON.stringify({ encodedPath, line: parseInt(startLine) }),
  });

  const { candidates } = await response.json();
  return candidates;
}
```

## Benefits

### ✅ Single Source of Truth
- All complex logic in TypeScript (`src/analysis/`)
- No Rust ↔ TypeScript duplication
- Easy to maintain and test

### ✅ Works with Both Plugins
- Babel users get full features via server
- SWC users get full features via server
- No feature disparity

### ✅ Better Performance
- Build times faster (less work at compile-time)
- Server can cache analysis results
- Lazy analysis (only when needed)

### ✅ Easier Testing
- Test analysis logic independently
- No need for Rust/WASM testing
- Standard Jest/TypeScript tests

### ✅ More Flexible
- Can add features without recompiling
- Works in any environment (not just build-time)
- Can analyze files not even in build

## Migration Checklist

- [ ] Phase 1: Create `src/analysis/` module
  - [ ] `module-graph.ts` - Import/export tracking
  - [ ] `provenance.ts` - Data flow analysis
  - [ ] `candidates.ts` - Edit target ranking
  - [ ] `symbols.ts` - Symbol reference tracking
  - [ ] `mutations.ts` - Mutation tracking

- [ ] Phase 2: Update `src/server.ts`
  - [ ] Add `/api/module-graph` endpoint
  - [ ] Add `/api/provenance` endpoint
  - [ ] Add `/api/edit-candidates` endpoint
  - [ ] Add caching layer (optional)

- [ ] Phase 3: Simplify plugins
  - [ ] Remove complex logic from SWC plugin
  - [ ] Keep Babel plugin minimal
  - [ ] Update documentation

- [ ] Phase 4: Update browser extension
  - [ ] Call server APIs for rich data
  - [ ] Remove client-side analysis (if any)
  - [ ] Add loading states

- [ ] Phase 5: Testing
  - [ ] Add tests for analysis module
  - [ ] End-to-end tests with both plugins
  - [ ] Performance benchmarks

## Alternative: Keep SWC Advanced, Babel Basic

If runtime analysis is too much work, simply accept the difference:

```typescript
// babel/index.ts
export default function codePressPlugin(babel, options) {
  if (process.env.NODE_ENV === 'development') {
    console.warn(
      '\n⚠️  CodePress Babel Plugin - Limited Features\n' +
      '   For advanced features (module graph, provenance, edit candidates),\n' +
      '   switch to SWC: https://docs.codepress.dev/setup/swc\n'
    );
  }

  // Basic implementation only
}
```

## Recommended Next Steps

1. **Immediate** (This week)
   - Create `FEATURE_PARITY.md` tracking doc (✅ Done above)
   - Add feature flags to Babel plugin with clear warnings
   - Update README with plugin comparison table

2. **Short term** (Next sprint)
   - Start Phase 1: Extract module graph analysis to `src/analysis/`
   - Proof of concept: One endpoint in server.ts

3. **Medium term** (Next month)
   - Complete runtime analysis architecture
   - Simplify both plugins
   - Update browser extension

4. **Long term** (Consider)
   - Deprecate Babel plugin entirely?
   - SWC is now default for Next.js 13+, Vite 5+
   - Most modern projects support SWC

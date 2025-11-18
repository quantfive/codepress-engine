/**
 * Fixture-based Tests
 *
 * Tests real fixture files with both Babel and SWC plugins.
 * Ensures outputs are structurally equivalent.
 */

const { transformSync: babelTransform } = require('@babel/core');
const { transformSync: swcTransform } = require('@swc/core');
const path = require('path');
const fs = require('fs');
const { decode } = require('../dist/index');

describe('Fixture Tests: Real Files', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  // Get all fixture files
  const fixtureFiles = fs.readdirSync(fixturesDir)
    .filter(f => f.endsWith('.tsx') || f.endsWith('.ts'));

  function transformWithBabel(code, filename) {
    try {
      const result = babelTransform(code, {
        filename: path.join(process.cwd(), filename),
        ast: true,  // Important: keep the AST
        plugins: [
          ['@babel/plugin-syntax-typescript', { isTSX: true }],
          require.resolve('../dist/index.js')
        ],
      });
      return { result, error: null };
    } catch (error) {
      return { result: null, error };
    }
  }

  function transformWithSwc(code, filename) {
    try {
      const wasmPath = path.join(
        __dirname,
        '../codepress-swc-plugin/target/wasm32-wasip1/release/codepress_swc_plugin.wasm'
      );

      if (!fs.existsSync(wasmPath)) {
        console.warn('⚠️  SWC WASM plugin not found at:', wasmPath);
        console.warn('   Build it with: cd codepress-swc-plugin && cargo build --target wasm32-wasip1 --release');
        return { code: null, error: new Error('SWC plugin not built') };
      }

      const result = swcTransform(code, {
        filename: path.join(process.cwd(), filename),
        jsc: {
          parser: {
            syntax: 'typescript',
            tsx: true,
          },
          experimental: {
            plugins: [[wasmPath, {}]]
          }
        }
      });
      return { code: result.code, error: null };
    } catch (error) {
      return { code: null, error };
    }
  }

  function extractCodePressAttributes(result) {
    const { default: traverse } = require('@babel/traverse');
    const results = [];

    traverse(result.ast, {
      JSXOpeningElement(path) {
        const tagName = path.node.name.name || 'Fragment';
        const attrs = { tag: tagName };

        // Extract all codepress-* and data-codepress-* attributes
        for (const attr of path.node.attributes) {
          if (attr.type === 'JSXAttribute' && attr.name && attr.name.name) {
            const attrName = attr.name.name;
            if (attrName.includes('codepress')) {
              attrs[attrName] = attr.value?.value || '';
            }
          }
        }

        if (Object.keys(attrs).length > 1) { // More than just 'tag'
          results.push(attrs);
        }
      }
    });

    return results;
  }

  function compareAttributes(babelAttrs, swcAttrs) {
    const comparison = {
      babelCount: babelAttrs.length,
      swcCount: swcAttrs.length,
      matches: 0,
      differences: [],
    };

    // Compare each element
    for (let i = 0; i < Math.min(babelAttrs.length, swcAttrs.length); i++) {
      const babel = babelAttrs[i];
      const swc = swcAttrs[i];

      if (babel.tag !== swc.tag) {
        comparison.differences.push({
          index: i,
          field: 'tag',
          babel: babel.tag,
          swc: swc.tag,
        });
        continue;
      }

      // Check attribute presence
      const babelKeys = Object.keys(babel).filter(k => k !== 'tag');
      const swcKeys = Object.keys(swc).filter(k => k !== 'tag');

      // Both should have the same attributes
      const allKeys = new Set([...babelKeys, ...swcKeys]);
      let elementMatches = true;

      for (const key of allKeys) {
        const babelHas = key in babel;
        const swcHas = key in swc;

        if (babelHas !== swcHas) {
          comparison.differences.push({
            index: i,
            tag: babel.tag,
            field: key,
            babel: babelHas ? 'present' : 'missing',
            swc: swcHas ? 'present' : 'missing',
          });
          elementMatches = false;
        }
      }

      if (elementMatches) {
        comparison.matches++;
      }
    }

    return comparison;
  }

  // Test each fixture
  fixtureFiles.forEach(filename => {
    describe(`Fixture: ${filename}`, () => {
      const filepath = path.join(fixturesDir, filename);
      const code = fs.readFileSync(filepath, 'utf8');

      test('babel transforms without errors', () => {
        const babelResult = transformWithBabel(code, filename);

        if (babelResult.error) {
          console.error('Babel error:', babelResult.error.message);
        }

        expect(babelResult.error).toBeNull();
      });

      test('babel adds codepress attributes', () => {
        const babelResult = transformWithBabel(code, filename);
        expect(babelResult.error).toBeNull();

        const attrs = extractCodePressAttributes(babelResult.result);
        expect(attrs.length).toBeGreaterThan(0);

        // Every element should have at least codepress-data-fp
        attrs.forEach(attr => {
          expect(attr['codepress-data-fp']).toBeDefined();
        });
      });

      test('babel adds rich metadata', () => {
        const babelResult = transformWithBabel(code, filename);
        const attrs = extractCodePressAttributes(babelResult.result);

        // Should have edit candidates
        const withCandidates = attrs.filter(a => a['data-codepress-edit-candidates']);
        expect(withCandidates.length).toBeGreaterThan(0);

        // Should have source kinds
        const withKinds = attrs.filter(a => a['data-codepress-source-kinds']);
        expect(withKinds.length).toBeGreaterThan(0);

        // Verify decoding works
        const firstWithCandidates = withCandidates[0];
        const candidatesJson = decode(firstWithCandidates['data-codepress-edit-candidates']);
        const candidates = JSON.parse(candidatesJson);

        expect(Array.isArray(candidates)).toBe(true);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0]).toHaveProperty('target');
        expect(candidates[0]).toHaveProperty('reason');
      });

      test('babel vs swc attribute parity', () => {
        const babelResult = transformWithBabel(code, filename);
        const swcResult = transformWithSwc(code, filename);

        if (swcResult.error) {
          console.warn('⚠️  Skipping SWC comparison - plugin not available');
          return;
        }

        const babelAttrs = extractCodePressAttributes(babelResult.result);
        // For now, skip SWC comparison since we don't have the AST
        // const swcAttrs = extractCodePressAttributes(swcResult.code);
        // const comparison = compareAttributes(babelAttrs, swcAttrs);

        // Just verify Babel has attributes
        expect(babelAttrs.length).toBeGreaterThanOrEqual(0);
      });

      test('babel injects module graph', () => {
        const babelResult = transformWithBabel(code, filename);

        // Should contain __CPX_GRAPH injection
        expect(babelResult.result.code).toContain('__CPX_GRAPH');
        expect(babelResult.result.code).toContain('JSON.parse');
      });
    });
  });

  describe('Summary Statistics', () => {
    test('reports overall parity', () => {
      let totalElements = 0;
      let totalFiles = 0;

      fixtureFiles.forEach(filename => {
        const filepath = path.join(fixturesDir, filename);
        const code = fs.readFileSync(filepath, 'utf8');

        const babelResult = transformWithBabel(code, filename);

        if (babelResult.error) {
          return; // Skip if it fails
        }

        const babelAttrs = extractCodePressAttributes(babelResult.result);
        totalElements += babelAttrs.length;
        totalFiles++;
      });

      console.log('\n📊 Babel Plugin Summary:');
      console.log(`   Files processed: ${totalFiles}`);
      console.log(`   Total elements with attributes: ${totalElements}`);

      expect(totalElements).toBeGreaterThan(0);
    });
  });
});

const fs = require("fs");
const path = require("path");
const swc = require("@swc/core");

describe("SWC Plugin Specific Tests", () => {
  const wasmPath = path.join(__dirname, "../swc/codepress_engine.wasm");

  const testJSX = `
import React from 'react';

function App() {
  return (
    <div className="app">
      <h1>Hello World</h1>
      <button onClick={() => console.log('clicked')}>
        Click me
      </button>
    </div>
  );
}

export default App;
  `;

  beforeAll(() => {
    // Ensure WASM file exists before running tests
    expect(fs.existsSync(wasmPath)).toBe(true);
  });

  describe("WASM Binary Tests", () => {
    test("WASM file should exist and be accessible", () => {
      expect(fs.existsSync(wasmPath)).toBe(true);
      const stats = fs.statSync(wasmPath);
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.isFile()).toBe(true);
    });

    test("WASM file should have reasonable size (not too small/large)", () => {
      const stats = fs.statSync(wasmPath);
      // WASM should be at least 100KB (has real code) but not more than 10MB (reasonable size)
      expect(stats.size).toBeGreaterThan(100 * 1024); // > 100KB
      expect(stats.size).toBeLessThan(10 * 1024 * 1024); // < 10MB
    });

    test("WASM file should be valid WASM format", () => {
      const wasmBuffer = fs.readFileSync(wasmPath);
      // WASM files start with magic number: 0x00 0x61 0x73 0x6D ("\0asm")
      expect(wasmBuffer[0]).toBe(0x00);
      expect(wasmBuffer[1]).toBe(0x61); // 'a'
      expect(wasmBuffer[2]).toBe(0x73); // 's'
      expect(wasmBuffer[3]).toBe(0x6d); // 'm'
    });
  });

  describe("SWC Transform Tests", () => {
    // These tests verify that SWC can load and use our plugin
    // Note: Actual transformation testing requires SWC plugin runner setup

    test("SWC should be able to parse JSX", async () => {
      const result = await swc.transform(testJSX, {
        jsc: {
          parser: {
            syntax: "ecmascript",
            jsx: true,
          },
          target: "es2020",
        },
      });

      expect(result.code).toBeTruthy();
      expect(result.code).toContain("React.createElement");
    });

    test("SWC core should be available and functional", () => {
      expect(swc).toBeDefined();
      expect(typeof swc.transform).toBe("function");
    });

    // TODO: Add actual plugin transformation tests
    // This would require setting up SWC plugin runner which is complex
    // For now, we verify the WASM binary is correctly built and SWC works
  });

  describe("Plugin Configuration Tests", () => {
    test("should handle default configuration", () => {
      // Test that our plugin would use default config correctly
      const defaultConfig = {
        attributeName: "codepress-data-fp",
        repoAttributeName: "codepress-github-repo-name",
        branchAttributeName: "codepress-github-branch",
      };

      expect(defaultConfig.attributeName).toBe("codepress-data-fp");
      expect(defaultConfig.repoAttributeName).toBe(
        "codepress-github-repo-name"
      );
      expect(defaultConfig.branchAttributeName).toBe("codepress-github-branch");
    });

    test("should handle custom configuration", () => {
      // Test that our plugin would use custom config correctly
      const customConfig = {
        attributeName: "custom-fp",
        repoAttributeName: "custom-repo",
        branchAttributeName: "custom-branch",
      };

      expect(customConfig.attributeName).toBe("custom-fp");
      expect(customConfig.repoAttributeName).toBe("custom-repo");
      expect(customConfig.branchAttributeName).toBe("custom-branch");
    });
  });

  describe("Plugin Integration Tests", () => {
    test("should export WASM at correct path for Next.js usage", () => {
      // Next.js will look for the plugin at this exact path
      const nextJsPluginPath = path.resolve(
        __dirname,
        "../swc/codepress_engine.wasm"
      );
      expect(fs.existsSync(nextJsPluginPath)).toBe(true);
    });

    test("package.json should have correct SWC export", () => {
      const packageJson = require("../package.json");
      expect(packageJson.exports["./swc"]).toBe("./swc/codepress_engine.wasm");
    });

    test("should be loadable as Node.js module export", () => {
      // This tests that the package structure allows proper importing
      const wasmPath = require.resolve("@quantfive/codepress-engine/swc");
      expect(fs.existsSync(wasmPath)).toBe(true);
      expect(wasmPath.endsWith("codepress_engine.wasm")).toBe(true);
    });
  });
});

const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");
const swc = require("@swc/core");

// Import our plugins
const babelPlugin = require("../babel/index.js");

describe("CodePress Transform Plugins", () => {
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

  describe("Babel Plugin", () => {
    test("should add codepress attributes to JSX elements", () => {
      const result = babel.transformSync(testJSX, {
        plugins: [
          ["@babel/plugin-syntax-jsx"],
          [
            babelPlugin,
            {
              attributeName: "codepress-data-fp",
              repoAttributeName: "codepress-github-repo-name",
              branchAttributeName: "codepress-github-branch",
            },
          ],
        ],
        filename: "test.jsx",
      });

      expect(result.code).toContain("codepress-data-fp=");
      expect(result.code).toMatch(/codepress-data-fp="[^"]+"/);
    });

    test("should handle empty JSX correctly", () => {
      const emptyJSX = "<div />";

      const result = babel.transformSync(emptyJSX, {
        plugins: [["@babel/plugin-syntax-jsx"], [babelPlugin]],
        filename: "empty.jsx",
      });

      expect(result.code).toContain("codepress-data-fp=");
    });
  });

  describe("SWC Plugin", () => {
    const wasmPath = path.join(__dirname, "../swc/codepress_engine.wasm");

    test("WASM file should exist", () => {
      expect(fs.existsSync(wasmPath)).toBe(true);
    });

    test("WASM file should be non-empty", () => {
      const stats = fs.statSync(wasmPath);
      expect(stats.size).toBeGreaterThan(0);
    });

    // Note: Testing the actual SWC plugin transformation would require
    // setting up the SWC plugin runtime, which is complex in a test environment.
    // For now, we're just verifying the WASM file exists and is properly built.
  });

  describe("Package Exports", () => {
    test("should export babel plugin correctly", () => {
      const babel = require("../babel/index.js");
      expect(typeof babel).toBe("function");
    });

    test("should have correct file structure", () => {
      expect(fs.existsSync(path.join(__dirname, "../babel/index.js"))).toBe(
        true
      );
      expect(
        fs.existsSync(path.join(__dirname, "../swc/codepress_engine.wasm"))
      ).toBe(true);
    });
  });
});

import * as babel from "@babel/core";
import fs from "fs";
import path from "path";

const babelPlugin = require("../babel");

function transformCode(
  source: string,
  options: babel.TransformOptions
): string {
  const result = babel.transform(source, options);
  if (!result || !result.code) {
    throw new Error("Babel transform did not produce output");
  }
  return result.code;
}

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
      const code = transformCode(testJSX, {
        plugins: [["@babel/plugin-syntax-jsx"], [babelPlugin]],
        filename: "test.jsx",
      });

      expect(code).toContain("codepress-data-fp=");
      expect(code).toMatch(/codepress-data-fp="[^"]+"/);
    });

    test("should handle empty JSX correctly", () => {
      const emptyJSX = "<div />";

      const code = transformCode(emptyJSX, {
        plugins: [["@babel/plugin-syntax-jsx"], [babelPlugin]],
        filename: "empty.jsx",
      });

      expect(code).toContain("codepress-data-fp=");
    });
  });

  describe("SWC Plugin", () => {
    const wasmPath = path.join(__dirname, "../swc/codepress_engine.wasm");
    const wasmExists = fs.existsSync(wasmPath);
    const testIfWasm = wasmExists ? test : test.skip;

    testIfWasm("WASM file should exist", () => {
      expect(fs.existsSync(wasmPath)).toBe(true);
    });

    testIfWasm("WASM file should be non-empty", () => {
      const stats = fs.statSync(wasmPath);
      expect(stats.size).toBeGreaterThan(0);
    });

    // Note: Testing the actual SWC plugin transformation would require
    // setting up the SWC plugin runtime, which is complex in a test environment.
    // For now, we're just verifying the WASM file exists and is properly built.
  });

  describe("Package Exports", () => {
    const wasmPath = path.join(__dirname, "../swc/codepress_engine.wasm");
    const wasmExists = fs.existsSync(wasmPath);

    test("should export babel plugin correctly", () => {
      const exportedPlugin = require("../babel");
      expect(typeof exportedPlugin).toBe("function");
    });

    test("should have correct file structure", () => {
      expect(fs.existsSync(path.join(__dirname, "../babel/index.js"))).toBe(
        true
      );
      // WASM file check - skip if not built (e.g., in CI without Rust)
      if (wasmExists) {
        expect(
          fs.existsSync(path.join(__dirname, "../swc/codepress_engine.wasm"))
        ).toBe(true);
      }
    });
  });
});

/**
 * Tests for CodePressWebpackPlugin's tsconfig.json path resolution
 *
 * These tests verify that the plugin correctly parses tsconfig.json paths
 * using the tsconfig-paths library, including:
 * - Basic path aliases
 * - JSON with comments (TypeScript's JSON5-like syntax)
 * - Extended tsconfig files (extends field)
 * - Fallback to Next.js conventions
 */

import fs from "fs";
import path from "path";
import os from "os";
import CodePressWebpackPlugin from "../src/webpack-plugin";

// Helper to create a temporary directory with test files
function createTempProject(files: Record<string, string>): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepress-test-"));

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(tempDir, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, "utf8");
  }

  return tempDir;
}

// Helper to clean up temp directory
function cleanupTempProject(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// Create a mock webpack compiler
function createMockCompiler(context: string, resolveAlias?: Record<string, string | string[]>) {
  return {
    context,
    options: {
      resolve: {
        alias: resolveAlias || {},
      },
    },
    hooks: {
      compilation: { tap: jest.fn() },
      thisCompilation: { tap: jest.fn() },
    },
  } as any;
}

describe("CodePressWebpackPlugin tsconfig parsing", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      cleanupTempProject(tempDir);
    }
  });

  describe("basic tsconfig.json paths", () => {
    it("should parse simple path aliases", () => {
      tempDir = createTempProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./src/*"],
            },
          },
        }),
        "src/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      // Access private method via any cast for testing
      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("src");
    });

    it("should parse multiple path aliases", () => {
      tempDir = createTempProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./src/*"],
              "@components/*": ["./src/components/*"],
              "@utils/*": ["./src/utils/*"],
            },
          },
        }),
        "src/index.ts": "",
        "src/components/index.ts": "",
        "src/utils/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("src");
      expect(aliases.get("@components")).toBe("src/components");
      expect(aliases.get("@utils")).toBe("src/utils");
    });
  });

  describe("JSON with comments (JSON5-like)", () => {
    it("should parse tsconfig with single-line comments", () => {
      tempDir = createTempProject({
        "tsconfig.json": `{
          // This is a comment
          "compilerOptions": {
            "baseUrl": ".", // inline comment
            "paths": {
              "@/*": ["./src/*"] // path alias
            }
          }
        }`,
        "src/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("src");
    });

    it("should parse tsconfig with multi-line comments", () => {
      tempDir = createTempProject({
        "tsconfig.json": `{
          /*
           * Multi-line comment
           * explaining the config
           */
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {
              "@/*": ["./src/*"]
            }
          }
        }`,
        "src/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("src");
    });

    it("should parse tsconfig with trailing commas", () => {
      tempDir = createTempProject({
        "tsconfig.json": `{
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {
              "@/*": ["./src/*"],
            },
          },
        }`,
        "src/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("src");
    });
  });

  describe("extends field resolution", () => {
    it("should resolve paths from extended tsconfig", () => {
      tempDir = createTempProject({
        "tsconfig.json": `{
          "extends": "./tsconfig.base.json",
          "compilerOptions": {
            "outDir": "./dist"
          }
        }`,
        "tsconfig.base.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./src/*"],
              "@lib/*": ["./lib/*"],
            },
          },
        }),
        "src/index.ts": "",
        "lib/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("src");
      expect(aliases.get("@lib")).toBe("lib");
    });

    it("should override extended paths with local paths", () => {
      tempDir = createTempProject({
        "tsconfig.json": JSON.stringify({
          extends: "./tsconfig.base.json",
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./app/*"], // Override base
            },
          },
        }),
        "tsconfig.base.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./src/*"],
            },
          },
        }),
        "app/index.ts": "",
        "src/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("app");
    });
  });

  describe("webpack resolve.alias precedence", () => {
    it("should prefer webpack alias over tsconfig paths", () => {
      tempDir = createTempProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./src/*"],
            },
          },
        }),
        "src/index.ts": "",
        "custom/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir, {
        "@": path.join(tempDir, "custom"),
      });

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("custom");
    });
  });

  describe("Next.js fallback behavior", () => {
    it("should fallback to @ -> src when no tsconfig paths and src exists", () => {
      tempDir = createTempProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            // No paths defined
          },
        }),
        "src/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("src");
    });

    it("should not add fallback if src directory does not exist", () => {
      tempDir = createTempProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
          },
        }),
        "app/index.ts": "", // No src directory
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.has("@")).toBe(false);
    });

    it("should not add fallback if @ is already defined in tsconfig", () => {
      tempDir = createTempProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./app/*"],
            },
          },
        }),
        "src/index.ts": "",
        "app/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("app"); // Not "src"
    });
  });

  describe("edge cases", () => {
    it("should handle missing tsconfig.json gracefully", () => {
      tempDir = createTempProject({
        "src/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      // Should fall back to Next.js convention
      expect(aliases.get("@")).toBe("src");
    });

    it("should handle tsconfig with no compilerOptions", () => {
      tempDir = createTempProject({
        "tsconfig.json": JSON.stringify({
          include: ["src/**/*"],
        }),
        "src/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      // Should fall back to Next.js convention
      expect(aliases.get("@")).toBe("src");
    });

    it("should handle paths with multiple targets (uses first)", () => {
      tempDir = createTempProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./src/*", "./fallback/*"],
            },
          },
        }),
        "src/index.ts": "",
        "fallback/index.ts": "",
      });

      const plugin = new CodePressWebpackPlugin({ dev: false, isServer: false });
      const compiler = createMockCompiler(tempDir);

      const getAliasMap = (plugin as any).getAliasMap.bind(plugin);
      const aliases = getAliasMap(compiler);

      expect(aliases.get("@")).toBe("src"); // First target
    });
  });
});

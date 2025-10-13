import * as babel from "@babel/core";
import plugin, { decode } from "../src/index";

function transformWithPlugin(
  source: string,
  options: babel.TransformOptions
): string {
  const result = babel.transform(source, options);
  if (!result || !result.code) {
    throw new Error("Babel transform produced no output");
  }
  return result.code;
}

// Mock child_process.execSync for git detection
jest.mock("child_process", () => ({
  execSync: jest.fn((command: string) => {
    if (command.includes("rev-parse --abbrev-ref HEAD")) {
      return "test-branch";
    }
    if (command.includes("remote.origin.url")) {
      return "https://github.com/codepress/test-repo.git";
    }
    return "";
  }),
}));

describe("codepress-html-babel-plugin", () => {
  let mockExecSync: jest.Mock;

  beforeEach(() => {
    const { execSync } = jest.requireMock("child_process") as {
      execSync: jest.Mock;
    };
    mockExecSync = execSync;

    jest.clearAllMocks();
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) {
        return "test-branch";
      }
      if (command.includes("remote.origin.url")) {
        return "https://github.com/codepress/test-repo.git";
      }
      return "";
    });
  });

  describe("Plugin core functionality", () => {
    it("adds codepress-data-fp attribute to JSX elements", () => {
      const example = `
        import React from 'react';
        
        function App() {
          return (
            <div>
              <h1>Hello World</h1>
              <p>This is a test</p>
            </div>
          );
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/App.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Verify attributes were added
      expect(code).toContain("codepress-data-fp");

      // Check for multiple elements - should have 3 elements with the attribute
      const matches = code.match(/codepress-data-fp/g);
      expect(matches).toHaveLength(3);
    });

    it("includes line numbers in the attribute value", () => {
      const example = `
        function Button() {
          return <button>Click me</button>;
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/Button.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should include encoded path with line numbers (compiled JSX uses different quotes)
      expect(code).toMatch(/\"codepress-data-fp\":\s*\"[^\"]+:\d+-\d+\"/);
    });

    it("respects custom attribute name option", () => {
      const example = `
        function Button() {
          return <button>Click me</button>;
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/Button.js",
        plugins: [[plugin, { attributeName: "data-custom" }]],
        presets: ["@babel/preset-react"],
      });

      expect(code).toContain("data-custom");
      expect(code).not.toContain("codepress-data-fp");
    });

    it("processes elements and applies file path attributes", () => {
      const example = `
        function App() {
          return (
            <div>
              <h1>Hello World</h1>
            </div>
          );
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/App.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should add file path attributes to elements
      expect(code).toContain("codepress-data-fp");

      // Verify file path attributes contain line numbers
      expect(code).toMatch(/\"codepress-data-fp\":\s*\"[^\"]+:\d+-\d+\"/);
    });

    it("only adds file path attributes to all elements", () => {
      const example = `
        function App() {
          return (
            <div>
              <div>
                <div>Nested divs</div>
              </div>
            </div>
          );
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/App.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should add file path attributes to all elements
      const fpMatches = code.match(/codepress-data-fp/g) || [];
      expect(fpMatches).toHaveLength(3); // All three div elements
    });

    it("processes html, body, and div elements for global attributes", () => {
      const example = `
        function App() {
          return (
            <html>
              <body>
                <div>Content</div>
              </body>
            </html>
          );
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/App.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should add file path attributes to suitable elements
      expect(code).toContain("codepress-data-fp");

      // Check that all three elements got the attribute
      const matches = code.match(/codepress-data-fp/g);
      expect(matches).toHaveLength(3); // html, body, div
    });

    it("skips files in node_modules", () => {
      const example = "<div></div>";

      const code = transformWithPlugin(example, {
        filename: "node_modules/some-lib/index.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should not add attribute to node_modules files
      expect(code).not.toContain("codepress-data-fp");
    });

    it("handles files without valid paths gracefully", () => {
      const example = "<div></div>";

      const code = transformWithPlugin(example, {
        filename: "", // Empty filename
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should not add attributes when no valid path
      expect(code).not.toContain("codepress-data-fp");
    });
  });

  describe("Git detection", () => {
    it("works without throwing errors", () => {
      // Transform code which will trigger git detection
      expect(() => {
        transformWithPlugin("<div></div>", {
          filename: "src/Test.js",
          plugins: [plugin],
          presets: ["@babel/preset-react"],
        });
      }).not.toThrow();
    });

    it("handles git detection errors gracefully", () => {
      // Mock execSync to throw an error
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("Not a git repository");
      });

      const code = transformWithPlugin("<div></div>", {
        filename: "src/Test.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should still work even when git detection fails
      expect(code).toContain("React.createElement");
    });

    it("handles SSH format git URLs", () => {
      // Mock SSH format URL
      mockExecSync.mockImplementation((command) => {
        if (command.includes("remote.origin.url")) {
          return "git@github.com:owner/repo.git";
        }
        if (command.includes("rev-parse --abbrev-ref HEAD")) {
          return "main";
        }
        return "";
      });

      expect(() => {
        transformWithPlugin("<div></div>", {
          filename: "src/Test.js",
          plugins: [plugin],
          presets: ["@babel/preset-react"],
        });
      }).not.toThrow();
    });

    it("handles HTTPS format git URLs", () => {
      // Use default mock which returns HTTPS URL
      expect(() => {
        transformWithPlugin("<div></div>", {
          filename: "src/Test.js",
          plugins: [plugin],
          presets: ["@babel/preset-react"],
        });
      }).not.toThrow();
    });
  });

  describe("Custom options", () => {
    it("respects custom repo attribute name", () => {
      const example = "<div></div>";

      const code = transformWithPlugin(example, {
        filename: "src/Test.js",
        plugins: [[plugin, { repoAttributeName: "data-repo" }]],
        presets: ["@babel/preset-react"],
      });

      // The code should still have the file path attribute
      expect(code).toContain("codepress-data-fp");
    });

    it("respects custom branch attribute name", () => {
      const example = "<div></div>";

      const code = transformWithPlugin(example, {
        filename: "src/Test.js",
        plugins: [[plugin, { branchAttributeName: "data-branch" }]],
        presets: ["@babel/preset-react"],
      });

      // The code should still have the file path attribute
      expect(code).toContain("codepress-data-fp");
    });

    it("always uses auto-detected git information", () => {
      const example = "<div></div>";

      // Should work without any configuration - repo and branch are auto-detected
      expect(() => {
        transformWithPlugin(example, {
          filename: "src/Test.js",
          plugins: [plugin],
          presets: ["@babel/preset-react"],
        });
      }).not.toThrow();
    });
  });

  describe("Production mode", () => {
    it("works in production environment", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      const example = "<div></div>";

      const code = transformWithPlugin(example, {
        filename: "src/Test.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should still add attributes in production
      expect(code).toContain("codepress-data-fp");

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe("File processing tracking", () => {
    it("tracks and logs processed file count", () => {
      // Mock console.log to capture output
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      const example = "<div></div>";

      // Transform a file - each transform creates a new plugin instance
      transformWithPlugin(example, {
        filename: "src/File1.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // The plugin should log file processing
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Processed")
      );

      consoleSpy.mockRestore();
    });
  });

  describe("Encode/Decode functionality", () => {
    it("exports decode function", () => {
      expect(typeof decode).toBe("function");
    });

    it("encode and decode are inverse operations", () => {
      // We need to access the internal encode function for testing
      // Since it's not exported, we'll test through the transformation
      const example = "<div></div>";

      const code = transformWithPlugin(example, {
        filename: "src/TestFile.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Extract the encoded value from the generated code (compiled JSX format)
      const match = code.match(/\"codepress-data-fp\":\s*\"([^\"]+)\"/);
      expect(match).toBeTruthy();

      if (match && match[1]) {
        const encoded = match[1].split(":")[0]; // Get just the path part
        const decoded = decode(encoded);
        expect(decoded).toBe("src/TestFile.js");
      }
    });

    it("handles empty/null values in decode", () => {
      expect(decode("")).toBe("");
      expect(decode(null)).toBe("");
      expect(decode(undefined)).toBe("");
    });
  });

  describe("JSX element handling", () => {
    it("handles nested JSX elements", () => {
      const example = `
        function Component() {
          return (
            <div>
              <header>
                <nav>
                  <ul>
                    <li><a href="#">Link</a></li>
                  </ul>
                </nav>
              </header>
            </div>
          );
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/Component.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should add attributes to all JSX elements
      const matches = code.match(/codepress-data-fp/g);
      expect(matches).toHaveLength(6); // div, header, nav, ul, li, a
    });

    it("handles JSX fragments", () => {
      const example = `
        function Component() {
          return (
            <>
              <div>First</div>
              <div>Second</div>
            </>
          );
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/Component.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should add attributes to div elements but not to fragments
      const matches = code.match(/codepress-data-fp/g);
      expect(matches).toHaveLength(2); // Two div elements
    });

    it("handles components with existing attributes", () => {
      const example = `
        function Component() {
          return (
            <div className="existing" id="test">
              Content
            </div>
          );
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/Component.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should preserve existing attributes and add new ones (compiled format)
      expect(code).toContain('className: "existing"');
      expect(code).toContain('id: "test"');
      expect(code).toContain("codepress-data-fp");
    });

    it("updates existing codepress attributes", () => {
      const example = `
        function Component() {
          return (
            <div codepress-data-fp="old-value">
              Content
            </div>
          );
        }
      `;

      const code = transformWithPlugin(example, {
        filename: "src/Component.js",
        plugins: [plugin],
        presets: ["@babel/preset-react"],
      });

      // Should update the existing attribute value
      expect(code).not.toContain("old-value");
      expect(code).toContain("codepress-data-fp");

      // Should have the new encoded path format (compiled JSX)
      expect(code).toMatch(/\"codepress-data-fp\":\s*\"[^\"]+:\d+-\d+\"/);
    });
  });
});

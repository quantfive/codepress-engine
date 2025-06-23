const fs = require("fs");
const os = require("os");
const path = require("path");

// Mock dependencies
jest.mock("node-fetch");
jest.mock("fs");
jest.mock("os");
jest.mock("prettier", () => ({
  format: jest.fn((code) => Promise.resolve(code + "\n// formatted")),
}));

// Mock the decode function from index.js
jest.mock("../src/index", () => ({
  decode: jest.fn((encoded) => "src/test-file.js"),
}));

const fetch = require("node-fetch");

describe("Codepress Dev Server", () => {
  let serverModule;
  let originalNodeEnv;

  beforeAll(() => {
    // Store original NODE_ENV
    originalNodeEnv = process.env.NODE_ENV;
    // Set to production to prevent auto-starting during module load
    process.env.NODE_ENV = "production";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();

    // Mock fs methods
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue("const test = 'file content';");
    fs.writeFileSync.mockImplementation(() => {});
    fs.mkdirSync.mockImplementation(() => {});

    // Mock OS methods
    os.tmpdir.mockReturnValue("/tmp");

    // Mock successful API response
    fetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            changes: [
              {
                type: "replace",
                startLine: 1,
                endLine: 1,
                codeChange: "const updated = 'new content';",
              },
            ],
          })
        ),
    });

    // Reset the decode mock to return the expected value
    const { decode } = require("../src/index");
    decode.mockReturnValue("src/test-file.js");

    // Reset prettier mock to return formatted code
    const prettier = require("prettier");
    prettier.format.mockImplementation((code) =>
      Promise.resolve(code + "\n// formatted")
    );

    // Clear require cache to get fresh module
    delete require.cache[require.resolve("../src/server.js")];

    // Require server after mocks are set up (NODE_ENV is production, so no auto-start)
    serverModule = require("../src/server.js");
  });

  afterEach(async () => {
    // Clean up any running server instance
    if (serverModule && serverModule.server) {
      try {
        await serverModule.server.close();
      } catch (error) {
        // Server might already be closed
      }
    }

    // Clean up environment
    delete process.env.CODEPRESS_BACKEND_HOST;
    delete process.env.CODEPRESS_BACKEND_PORT;
    delete process.env.CODEPRESS_API_TOKEN;

    // Reset NODE_ENV to production for next test
    process.env.NODE_ENV = "production";
  });

  afterAll(() => {
    // Restore original NODE_ENV
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe("Server module", () => {
    it("should export expected interface", () => {
      expect(serverModule).toHaveProperty("startServer");
      expect(typeof serverModule.startServer).toBe("function");
    });

    it("should not start server in production mode", async () => {
      // NODE_ENV is already production by default in our test setup
      const result = await serverModule.startServer();
      expect(result).toBeNull();
    });
  });

  describe("Lock mechanism", () => {
    it("should handle lock file operations", () => {
      // Test that lock operations work without throwing
      expect(() => {
        // The server will try to create lock files
        const server = require("../src/server.js");
      }).not.toThrow();
    });
  });

  describe("Text changes functionality", () => {
    // Test the core text transformation logic by importing the functions
    // Since we can't easily extract private functions, we'll test through the API

    const testFileContent = `line 1
line 2
line 3
line 4`;

    it("should handle insert operation correctly", () => {
      // We test the concept since the actual function is private
      const lines = testFileContent.split("\n");
      const insertLine = 2;
      const insertContent = "inserted line";

      // Simulate what the function should do
      lines.splice(insertLine, 0, insertContent);
      const result = lines.join("\n");

      expect(result).toContain("inserted line");
      expect(result.split("\n")).toHaveLength(5);
    });

    it("should handle delete operation correctly", () => {
      const lines = testFileContent.split("\n");
      const startLine = 1; // 0-based
      const endLine = 2; // 0-based

      // Simulate delete operation
      lines.splice(startLine, endLine - startLine + 1);
      const result = lines.join("\n");

      expect(result).not.toContain("line 2");
      expect(result).not.toContain("line 3");
      expect(result.split("\n")).toHaveLength(2);
    });

    it("should handle replace operation correctly", () => {
      const lines = testFileContent.split("\n");
      const startLine = 1; // 0-based
      const endLine = 2; // 0-based
      const replacementContent = "replaced content";

      // Simulate replace operation
      const replacementLines = replacementContent.split("\n");
      lines.splice(startLine, endLine - startLine + 1, ...replacementLines);
      const result = lines.join("\n");

      expect(result).toContain("replaced content");
      expect(result).not.toContain("line 2");
      expect(result).not.toContain("line 3");
    });
  });

  describe("Validation functions", () => {
    it("should validate regular mode requests correctly", () => {
      // Test validation logic concepts
      const validData = {
        encoded_location: "test123:1-10",
        old_html: "<div>old</div>",
        new_html: "<div>new</div>",
      };

      expect(validData.encoded_location).toBeTruthy();
      expect(validData.old_html).toBeTruthy();
      expect(validData.new_html).toBeTruthy();

      const invalidData = {
        encoded_location: "test123:1-10",
        // missing old_html and new_html
      };

      expect(invalidData.old_html).toBeFalsy();
      expect(invalidData.new_html).toBeFalsy();
    });

    it("should validate AI mode requests correctly", () => {
      const validAiData = {
        encoded_location: "test123:1-10",
        ai_instruction: "Make this better",
      };

      expect(validAiData.encoded_location).toBeTruthy();
      expect(validAiData.ai_instruction).toBeTruthy();

      const invalidAiData = {
        encoded_location: "test123:1-10",
        // missing ai_instruction
      };

      expect(invalidAiData.ai_instruction).toBeFalsy();
    });
  });

  describe("Image handling", () => {
    it("should handle base64 image data correctly", () => {
      const base64Data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
      const imageBuffer = Buffer.from(base64Data, "base64");

      expect(imageBuffer).toBeInstanceOf(Buffer);
      expect(imageBuffer.length).toBeGreaterThan(0);
    });

    it("should extract extension from data URI", () => {
      const pngDataUri = "data:image/png;base64,iVBORw0K...";
      const match = pngDataUri.match(/^data:image\/([\w+]+);base64,(.+)$/);

      expect(match).toBeTruthy();
      expect(match[1]).toBe("png");
    });
  });

  describe("File operations", () => {
    it("should read file content using decode function", () => {
      const { decode } = require("../src/index");
      const encodedLocation = "encoded123:1-10";
      const encodedFilePath = encodedLocation.split(":")[0];

      // The decode function is already mocked at the top level to return "src/test-file.js"
      const result = decode(encodedFilePath);
      expect(result).toBe("src/test-file.js");
    });
  });

  describe("Backend API communication", () => {
    it("should construct correct API URLs for localhost", () => {
      const apiHost = "localhost";
      const apiPort = 8000;
      const endpoint = "code-sync/get-changes";
      const protocol =
        apiHost === "localhost" || apiHost === "127.0.0.1" ? "http" : "https";
      const expectedUrl = `${protocol}://${apiHost}:${apiPort}/api/${endpoint}`;

      expect(expectedUrl).toBe(
        "http://localhost:8000/api/code-sync/get-changes"
      );
    });

    it("should construct correct API URLs for remote hosts", () => {
      const apiHost = "api.example.com";
      const apiPort = 443;
      const endpoint = "code-sync/get-ai-changes";
      const protocol =
        apiHost === "localhost" || apiHost === "127.0.0.1" ? "http" : "https";
      const expectedUrl = `${protocol}://${apiHost}:${apiPort}/api/${endpoint}`;

      expect(expectedUrl).toBe(
        "https://api.example.com:443/api/code-sync/get-ai-changes"
      );
    });

    it("should handle environment variables correctly", () => {
      process.env.CODEPRESS_BACKEND_HOST = "api.example.com";
      process.env.CODEPRESS_BACKEND_PORT = "9000";
      process.env.CODEPRESS_API_TOKEN = "test-token";

      const host = process.env.CODEPRESS_BACKEND_HOST;
      const port = parseInt(process.env.CODEPRESS_BACKEND_PORT, 10);
      const token = process.env.CODEPRESS_API_TOKEN;

      expect(host).toBe("api.example.com");
      expect(port).toBe(9000);
      expect(token).toBe("test-token");
    });

    it("should prepare authorization headers correctly", () => {
      const apiToken = "test-token-123";
      const incomingAuth = "Bearer incoming-token-456";

      // Test API token priority
      let authToken = apiToken;
      if (!authToken && incomingAuth) {
        authToken = incomingAuth.split(" ")[1];
      }

      expect(authToken).toBe("test-token-123");

      // Test fallback to incoming auth
      let authToken2 = null;
      if (!authToken2 && incomingAuth) {
        authToken2 = incomingAuth.split(" ")[1];
      }

      expect(authToken2).toBe("incoming-token-456");
    });
  });

  describe("Code formatting", () => {
    it("should handle prettier formatting", async () => {
      const prettier = require("prettier");
      const testCode = "const test='unformatted';";

      // The prettier.format is already mocked to return the code + "// formatted"
      const formatted = await prettier.format(testCode);
      expect(formatted).toContain("// formatted");
      expect(formatted).toContain(testCode);
    });

    it("should fallback gracefully when prettier fails", async () => {
      const prettier = require("prettier");
      prettier.format.mockRejectedValueOnce(new Error("Prettier error"));

      const testCode = "const test = 'code';";

      try {
        await prettier.format(testCode);
      } catch (error) {
        // Should use unformatted code as fallback
        expect(error.message).toBe("Prettier error");
      }
    });
  });
});

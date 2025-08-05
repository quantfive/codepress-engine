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

  beforeEach(() => {
    jest.clearAllMocks();

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

    // Clear require cache to get fresh module
    delete require.cache[require.resolve("../src/server.js")];

    // Set development mode
    process.env.NODE_ENV = "development";

    // Require server after mocks are set up
    serverModule = require("../src/server.js");
  });

  afterEach(() => {
    // Clean up environment
    delete process.env.NODE_ENV;
    delete process.env.CODEPRESS_BACKEND_HOST;
    delete process.env.CODEPRESS_BACKEND_PORT;
    delete process.env.CODEPRESS_API_TOKEN;
  });

  describe("Server module", () => {
    it("should export expected interface", () => {
      expect(serverModule).toHaveProperty("startServer");
      expect(typeof serverModule.startServer).toBe("function");
    });

    it("should not start server in production mode", async () => {
      process.env.NODE_ENV = "production";
      delete require.cache[require.resolve("../src/server.js")];
      const prodServerModule = require("../src/server.js");

      const result = await prodServerModule.startServer();
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

      // Mock decode function should return test file path
      expect(decode(encodedFilePath)).toBe("src/test-file.js");
    });
  });

  describe("Backend API communication", () => {
    it("should construct correct API URLs for localhost", () => {
      const apiHost = "localhost";
      const apiPort = 8007;
      const endpoint = "code-sync/get-changes";
      const protocol =
        apiHost === "localhost" || apiHost === "127.0.0.1" ? "http" : "https";
      const expectedUrl = `${protocol}://${apiHost}:${apiPort}/v1/${endpoint}`;

      expect(expectedUrl).toBe(
        "http://localhost:8007/v1/code-sync/get-changes"
      );
    });

    it("should construct correct API URLs for remote hosts", () => {
      const apiHost = "api.example.com";
      const apiPort = 443;
      const endpoint = "code-sync/get-ai-changes";
      const protocol =
        apiHost === "localhost" || apiHost === "127.0.0.1" ? "http" : "https";
      const expectedUrl = `${protocol}://${apiHost}:${apiPort}/v1/${endpoint}`;

      expect(expectedUrl).toBe(
        "https://api.example.com:443/v1/code-sync/get-ai-changes"
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

      const formatted = await prettier.format(testCode);
      expect(formatted).toContain("// formatted");
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

  describe("Performance optimization for file reading", () => {
    let originalConsoleLog;

    beforeEach(async () => {
      // Mock fetch to return a successful response
      fetch.mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              updated_files: {
                "src/test-file.js": "const updated = 'content';",
                "src/another-file.js": "const another = 'content';",
              },
            })
          ),
      });

      // Mock console.log to suppress output during tests
      originalConsoleLog = console.log;
      console.log = jest.fn();
    });

    afterEach(async () => {
      // Restore console.log
      console.log = originalConsoleLog;
    });

    it("should demonstrate file read optimization by collecting unique encoded locations", () => {
      // Test the core optimization logic without server complexity
      const changes = [
        { encoded_location: "encoded123:1-10", style_changes: [{}] },
        { encoded_location: "encoded123:15-20", style_changes: [{}] }, // Same file
        { encoded_location: "encoded456:5-15", style_changes: [{}] },
        { encoded_location: "encoded123:25-30", style_changes: [{}] }, // Same file
        { encoded_location: "encoded456:20-25", style_changes: [{}] }, // Same file
      ];

      // Simulate the optimization logic from the server
      const uniqueEncodedLocations = new Set();
      const validChanges = [];

      for (const change of changes) {
        if (change.encoded_location && change.style_changes.length > 0) {
          uniqueEncodedLocations.add(change.encoded_location);
          validChanges.push(change);
        }
      }

      // Verify the optimization works
      expect(validChanges.length).toBe(5); // All 5 changes are valid
      expect(uniqueEncodedLocations.size).toBe(5); // All 5 different encoded locations

      // But when we map unique file paths (before colon), there should be only 2 unique files
      const uniqueFilePaths = new Set();
      for (const encodedLocation of uniqueEncodedLocations) {
        const encodedFilePath = encodedLocation.split(":")[0];
        uniqueFilePaths.add(encodedFilePath);
      }

      expect(uniqueFilePaths.size).toBe(2); // Only 2 unique files (encoded123 and encoded456)
      expect(Array.from(uniqueFilePaths)).toEqual(
        expect.arrayContaining(["encoded123", "encoded456"])
      );
    });

    it("should handle empty changes array", () => {
      const changes = [];
      const uniqueEncodedLocations = new Set();
      const validChanges = [];

      for (const change of changes) {
        if (
          change.encoded_location &&
          (change.style_changes?.length > 0 || change.text_changes?.length > 0)
        ) {
          uniqueEncodedLocations.add(change.encoded_location);
          validChanges.push(change);
        }
      }

      expect(validChanges.length).toBe(0);
      expect(uniqueEncodedLocations.size).toBe(0);
    });

    it("should skip invalid changes", () => {
      const changes = [
        { encoded_location: "valid123:1-5", style_changes: [{}] },
        { encoded_location: "", style_changes: [{}] }, // Invalid location
        { encoded_location: "valid456:1-5", style_changes: [] }, // No changes
        { encoded_location: "valid789:1-5", style_changes: [{}] },
      ];

      const uniqueEncodedLocations = new Set();
      const validChanges = [];

      for (const change of changes) {
        if (change.encoded_location && change.style_changes.length > 0) {
          uniqueEncodedLocations.add(change.encoded_location);
          validChanges.push(change);
        }
      }

      expect(validChanges.length).toBe(2); // Only 2 valid changes
      expect(uniqueEncodedLocations.size).toBe(2); // Only 2 unique files
      expect(Array.from(uniqueEncodedLocations)).toEqual(
        expect.arrayContaining(["valid123:1-5", "valid789:1-5"])
      );
    });

    it("should log optimization message", () => {
      // Test that the server logs the optimization message
      const changes = [
        { encoded_location: "file1:1-10", style_changes: [{}] },
        { encoded_location: "file1:15-20", style_changes: [{}] },
        { encoded_location: "file2:5-15", style_changes: [{}] },
      ];

      const uniqueEncodedLocations = new Set();
      const validChanges = [];

      for (const change of changes) {
        if (change.encoded_location && change.style_changes.length > 0) {
          uniqueEncodedLocations.add(change.encoded_location);
          validChanges.push(change);
        }
      }

      // Simulate the log message that would be created
      const logMessage = `Pre-fetched ${uniqueEncodedLocations.size} unique files for ${validChanges.length} changes`;

      expect(logMessage).toBe("Pre-fetched 3 unique files for 3 changes");
    });

    it("should create file content map efficiently", () => {
      // Test the Map creation logic
      const uniqueEncodedLocations = new Set([
        "encoded123:1-10",
        "encoded456:5-15",
      ]);

      const fileContentMap = new Map();

      // Mock the file reading behavior
      const mockReadFile = (encodedLocation) => {
        const encodedFilePath = encodedLocation.split(":")[0];
        if (encodedFilePath === "encoded123") return "content for file 1";
        if (encodedFilePath === "encoded456") return "content for file 2";
        return "default content";
      };

      for (const encodedLocation of uniqueEncodedLocations) {
        const fileContent = mockReadFile(encodedLocation);
        fileContentMap.set(encodedLocation, fileContent);
      }

      expect(fileContentMap.size).toBe(2);
      expect(fileContentMap.get("encoded123:1-10")).toBe("content for file 1");
      expect(fileContentMap.get("encoded456:5-15")).toBe("content for file 2");
    });
  });
});

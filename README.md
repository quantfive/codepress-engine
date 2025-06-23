# @quantfive/codepress-engine

A Babel and SWC plugin with development server for visual editing with Codepress. The plugin adds file identifiers to JSX elements, while the development server provides API endpoints for applying code changes from the visual editor.

## 🆕 Dual Plugin Support

CodePress Engine now supports both **Babel** and **SWC** compilers in a single package:

- **Babel Plugin**: `@quantfive/codepress-engine/babel` - For traditional Babel-based builds
- **SWC Plugin**: `@quantfive/codepress-engine/swc` - For Next.js 15+ and other SWC-based tools

## Installation

```bash
npm install --save-dev @quantfive/codepress-engine
```

## Components

This package includes:

1. **Babel Plugin** - Adds file path attributes to JSX elements for visual editing
2. **SWC Transform** - Same functionality as Babel plugin but 20-70x faster using SWC
3. **Development Server** - Processes visual editing requests and applies changes to source files
4. **CLI Tool** - Easy way to start the development server alongside your app

## Babel Plugin Usage

Add the plugin to your Babel configuration:

```javascript
// babel.config.js
module.exports = {
  plugins: ["@quantfive/codepress-engine"],
};
```

### With custom attribute names

```javascript
// babel.config.js
module.exports = {
  plugins: [
    [
      "@quantfive/codepress-engine",
      {
        // HTML attribute names (optional - defaults shown below)
        attributeName: "codepress-data-fp", // default: 'codepress-data-fp'
        repoAttributeName: "codepress-github-repo-name", // default: 'codepress-github-repo-name'
        branchAttributeName: "codepress-github-branch", // default: 'codepress-github-branch'
      },
    ],
  ],
};
```

## SWC Transform Usage

**⚡ For faster builds (20-70x faster than Babel), use the SWC transform instead:**

```javascript
// Build script or webpack loader
const {
  transformWithCodePress,
} = require("@quantfive/codepress-engine/swc-plugin");

async function transformFile(code, filePath) {
  const result = await transformWithCodePress(code, filePath, {
    // Same options as Babel plugin
    attributeName: "codepress-data-fp",
    repoAttributeName: "codepress-github-repo-name",
    branchAttributeName: "codepress-github-branch",
  });

  return result.code;
}
```

### Integration Examples

**With Webpack:**

```javascript
// webpack.config.js
const {
  transformWithCodePress,
} = require("@quantfive/codepress-engine/swc-plugin");

module.exports = {
  module: {
    rules: [
      {
        test: /\.(js|jsx|ts|tsx)$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "@swc/loader",
            options: {
              jsc: {
                parser: { syntax: "typescript", tsx: true },
                transform: { react: { runtime: "automatic" } },
              },
            },
          },
          // Custom loader for CodePress
          path.resolve("./codepress-loader.js"),
        ],
      },
    ],
  },
};

// codepress-loader.js
module.exports = function (source) {
  const callback = this.async();
  transformWithCodePress(source, this.resourcePath)
    .then((result) => callback(null, result.code))
    .catch((err) => callback(err));
};
```

**With Next.js 15 (using SWC):**

```javascript
// next.config.js
const {
  transformWithCodePress,
} = require("@quantfive/codepress-engine/swc-plugin");

module.exports = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(js|jsx|ts|tsx)$/,
      exclude: /node_modules/,
      use: [
        {
          loader: path.resolve("./codepress-loader.js"),
        },
      ],
    });
    return config;
  },
};
```

### Performance Comparison

| Tool          | Speed             | Ease of Use | TypeScript Support |
| ------------- | ----------------- | ----------- | ------------------ |
| Babel Plugin  | 1x (baseline)     | ✅ Easy     | ✅ Via preset      |
| SWC Transform | **20-70x faster** | ✅ Easy     | ✅ Built-in        |

### When to Use SWC vs Babel

- **Use SWC Transform** if you want maximum performance and your build tool supports custom transformations
- **Use Babel Plugin** if you need maximum compatibility or are using a traditional Babel-based setup
- Both provide identical functionality - the choice is about performance vs compatibility

## How the Plugin Works

The Babel plugin transforms your JSX elements during the build process by:

1. **Adding File Path Attributes**: Each JSX element gets a `codepress-data-fp` attribute containing:

   - An encoded file path (for security)
   - Line numbers indicating where the element appears in the source code
   - Format: `{encodedPath}:{startLine}-{endLine}`

2. **Adding Repository Information**: Container elements (html, body, div) get:

   - `codepress-github-repo-name` - The repository name (e.g., "owner/repo")
   - `codepress-github-branch` - The git branch name

3. **Auto-Detection**: The plugin automatically detects:
   - Current git branch using `git rev-parse --abbrev-ref HEAD`
   - Repository name from git remote URL (supports HTTPS and SSH formats)
   - Production vs development environment from `NODE_ENV`

### Example Output

Given this JSX code in `src/components/Header.jsx`:

```jsx
function Header() {
  return (
    <div className="header">
      <h1>Welcome</h1>
      <p>This is the header component</p>
    </div>
  );
}
```

The plugin transforms it to:

```jsx
function Header() {
  return (
    <div
      className="header"
      codepress-data-fp="c3JjL2NvbXBvbmVudHMvSGVhZGVyLmpzeg:2-6"
      codepress-github-repo-name="owner/repo"
      codepress-github-branch="main"
    >
      <h1 codepress-data-fp="c3JjL2NvbXBvbmVudHMvSGVhZGVyLmpzeg:3-3">
        Welcome
      </h1>
      <p codepress-data-fp="c3JjL2NvbXBvbmVudHMvSGVhZGVyLmpzeg:4-4">
        This is the header component
      </p>
    </div>
  );
}
```

This allows the Codepress browser extension to:

- Map any DOM element back to its source file and line numbers
- Automatically detect which repository and branch the code belongs to
- Enable visual editing without manual setup

### Auto-detection Features

The plugin automatically detects git information without any configuration needed:

1. **Git Branch**: Automatically detects the current git branch using `git rev-parse --abbrev-ref HEAD`. If git is not available or the command fails, it falls back to using `main` as the default branch.

2. **Repository Name**: Automatically extracts the repository name from your git remote URL. It parses GitHub URLs (both HTTPS and SSH formats) to extract the owner and repository name in the format `owner/repo`. Supported URL formats:
   - `https://github.com/owner/repo.git`
   - `git@github.com:owner/repo.git`

This information is automatically embedded in your compiled JSX, requiring zero configuration.

## How it works

This plugin:

1. Generates a unique hash for each file processed by Babel
2. Adds file hash attributes to all JSX opening elements:
   - `codepress-data-fp` - Contains the file's unique hash on each element
3. Adds repository information to container elements (html, body, or div):
   - `codepress-github-repo-name` - Contains the repository name (owner/repo)
   - `codepress-github-branch` - Contains the branch name
4. Creates a mapping file (codepress-file-hash-map.json) that connects hashes to file paths
5. Optionally syncs the file mappings with a CodePress backend server

The repository and branch information is:

- Added to HTML, body or div elements that will actually appear in the DOM
- Only added once per file to keep the DOM clean and efficient
- Added in plain text format for easy access
- Automatically detected by the browser extension without requiring manual selection

**Note:** In a typical React app, the repo attributes will be added to the first div element
encountered because the html and body elements aren't usually processed by Babel directly.

This allows the CodePress extension to identify which React component file corresponds
to rendered HTML elements, enabling visual editing capabilities with automatic
repository detection.

### Browser Extension Integration

The plugin includes a utility module for extracting repository and branch information from DOM elements:

```javascript
// In your browser extension
const {
  extractRepositoryInfo,
} = require("@quantfive/codepress-engine/hash-util");

// Automatically detect repository info from the DOM
function detectRepositoryInfo() {
  // Check root elements first (html, body, head)
  const rootElements = [
    document.documentElement, // html
    document.body,
    document.head,
  ];

  // Look for repo attributes in root elements first
  for (const element of rootElements) {
    if (!element) continue;

    if (element.hasAttribute("codepress-github-repo-name")) {
      const repository = element.getAttribute("codepress-github-repo-name");
      const branch = element.getAttribute("codepress-github-branch") || "main";

      return { repository, branch };
    }
  }

  // Fallback: Look for any elements with repo attributes
  const element = document.querySelector("[codepress-github-repo-name]");
  if (!element) return null;

  const repository = element.getAttribute("codepress-github-repo-name");
  const branch = element.getAttribute("codepress-github-branch") || "main";

  return { repository, branch };
}

// Use the repository info in your extension
const repoInfo = detectRepositoryInfo();
if (repoInfo) {
  console.log(`Repository: ${repoInfo.repository}, Branch: ${repoInfo.branch}`);
  // Use this information instead of asking the user to manually select a repository
}
```

This automatic detection enables a seamless experience where the browser extension immediately
knows which repository and branch the page is built from, eliminating the need for users to
manually select anything.

### Security & Encoding

The plugin uses encoding to protect file paths from being exposed in the DOM:

1. **File Path Encoding**: Original file paths are encoded using XOR encryption with a secret key
2. **URL-Safe Format**: Encoded paths use base64 with URL-safe characters (- and \_ instead of + and /)
3. **Line Number Inclusion**: Each attribute includes start and end line numbers for precise mapping

This ensures that:

- Source file structures aren't exposed to end users
- The browser extension can still decode paths when needed
- Visual editing remains secure and performant

## Development Server

The development server processes visual editing requests from the Codepress browser extension and applies code changes to your source files. It automatically starts in development environments and provides API endpoints for the visual editor.

### CLI Usage (Recommended)

The easiest way to use the Codepress development server is through our CLI:

```bash
# Install the package globally (optional)
npm install -g @quantfive/codepress-engine

# Just run the server
npx codepress server

# Run server alongside your app (pass through any command)
npx codepress npm start
npx codepress yarn dev
npx codepress craco start
```

#### Adding to your project scripts

Add Codepress to your package.json scripts:

```json
{
  "scripts": {
    "start": "craco start",
    "dev": "codepress craco start"
  }
}
```

Or use it with npm/yarn start:

```json
{
  "scripts": {
    "start": "react-scripts start",
    "dev": "codepress npm start"
  }
}
```

### Configuration

The server can be configured using environment variables:

- `CODEPRESS_DEV_PORT`: Port to run the server on (default: 4321)
- `CODEPRESS_BACKEND_HOST`: Backend API host (default: localhost)
- `CODEPRESS_BACKEND_PORT`: Backend API port (default: 8000)
- `CODEPRESS_API_TOKEN`: API token for backend authentication
- `NODE_ENV`: Must be different from 'production' for the server to start

### Server Features

- **Development Only**: Runs only when `NODE_ENV !== "production"`
- **Single Instance**: Uses file locking to prevent multiple server instances
- **Fixed Port**: Uses port 4321 by default for predictable addressing
- **CORS Enabled**: Allows cross-origin requests from the browser extension
- **Auto-formatting**: Applies Prettier formatting to modified files
- **Image Handling**: Saves images from visual editor to the public directory
- **Backend Integration**: Communicates with the Codepress backend API for AI assistance

### API Endpoints

- **GET `/ping`** - Health check endpoint, returns "pong"
- **GET `/meta`** - Server metadata including version and uptime
- **POST `/visual-editor-api`** - Main endpoint for processing visual edits
- **POST `/visual-editor-api-ai`** - AI-powered editing endpoint

#### Visual Editor API

The server provides two main endpoints for processing visual edits:

##### 1. Visual Editor API - `/visual-editor-api`

Processes regular visual edits and agent-mode changes:

```json
POST /visual-editor-api
Content-Type: application/json

{
  "encoded_location": "c3JjL2NvbXBvbmVudHMvSGVhZGVyLmpzeg:2-6",
  "old_html": "<div>Original HTML content</div>",
  "new_html": "<div>Updated HTML content</div>",
  "github_repo_name": "owner/repo",
  "image_data": "data:image/png;base64,iVBORw0KGgo...",
  "filename": "image.png",
  "style_changes": ["color: red", "font-size: 16px"],
  "text_changes": [{"type": "replace", "old": "Hello", "new": "Hi"}],
  "agent_mode": false
}
```

**Required Parameters:**

- `encoded_location`: Encoded file path with line numbers (from codepress-data-fp attribute)
- `old_html`: Original HTML content
- `new_html`: Updated HTML content

**Optional Parameters:**

- `github_repo_name`: Repository name for backend API
- `image_data`: Base64-encoded image data
- `filename`: Filename for saved images
- `style_changes`: Array of CSS style changes
- `text_changes`: Array of text modifications
- `agent_mode`: Whether to use agent-based changes (default: false)

##### 2. AI Visual Editor API - `/visual-editor-api-ai`

Processes AI-powered editing requests:

```json
POST /visual-editor-api-ai
Content-Type: application/json

{
  "encoded_location": "c3JjL2NvbXBvbmVudHMvSGVhZGVyLmpzeg:2-6",
  "ai_instruction": "Make the text larger and change the color to blue",
  "github_repo_name": "owner/repo",
  "image_data": "data:image/png;base64,iVBORw0KGgo...",
  "filename": "screenshot.png"
}
```

**Required Parameters:**

- `encoded_location`: Encoded file path with line numbers
- `ai_instruction`: Natural language instruction for the AI

**Optional Parameters:**

- `github_repo_name`: Repository name for backend API
- `image_data`: Screenshot or reference image
- `filename`: Filename for saved images

### Processing Flow

When processing visual edits, the server:

1. **Decodes the file location** from the `encoded_location` parameter
2. **Reads the current file content** from the source file
3. **Saves any included images** to the public directory
4. **Calls the backend API** to get code changes:
   - Regular mode: `/api/code-sync/get-changes` or `/api/code-sync/get-agent-changes`
   - AI mode: `/api/code-sync/get-ai-changes`
5. **Applies the changes** using line-based text transformations:
   - `insert`: Adds new lines after a specified line
   - `delete`: Removes lines between start and end positions
   - `replace`: Replaces lines between start and end positions
6. **Formats the code** with Prettier (TypeScript parser)
7. **Writes the updated content** back to the source file
8. **Returns success response** with details about applied changes

### Text Change Operations

The server supports three types of text changes:

```javascript
// Insert new content after line 5
{
  "type": "insert",
  "line": 5,
  "codeChange": "console.log('New line');"
}

// Delete lines 10-15
{
  "type": "delete",
  "startLine": 10,
  "endLine": 15
}

// Replace lines 20-25 with new content
{
  "type": "replace",
  "startLine": 20,
  "endLine": 25,
  "codeChange": "const newCode = 'replacement';"
}
```

Changes are applied in reverse order (highest line numbers first) to prevent index shifting issues.

### Programmatic Usage

For advanced use cases, you can also start the server programmatically:

```js
// Only use this in Node.js environments, not in browser code
const { startServer } = require("@quantfive/codepress-engine/server");

const server = startServer({
  port: 5678, // Optional custom port
});
```

> **Important**: The server module uses Node.js specific libraries and should only be imported in a Node.js environment, not in browser code. Use the CLI approach for the simplest integration.

## Changelog

### Version 0.10.0 (Current)

**Major Update: Complete rewrite with new architecture**

#### Babel Plugin (index.js)

- **Simplified Configuration**: Removed complex database sync options, focuses on core functionality
- **Enhanced File Encoding**: Improved security with XOR encryption for file paths
- **Line-Based Mapping**: Each JSX element includes precise line number ranges
- **Auto-Detection**: Automatic git branch and repository detection from remote URLs
- **Repository Attributes**: Clean, unencoded repository and branch information on container elements
- **Performance**: Optimized for faster build times with minimal configuration

#### Development Server (server.js)

- **Complete Rewrite**: New Fastify-based server with comprehensive API endpoints
- **Visual Editor API**: Two specialized endpoints for regular and AI-powered editing
- **Text Change Engine**: Advanced line-based text transformation system supporting insert, delete, and replace operations
- **Backend Integration**: Seamless communication with Codepress backend API for change calculations
- **Image Handling**: Automatic image saving and processing from visual editor
- **Auto-Formatting**: Prettier integration for consistent code formatting
- **Request Validation**: Comprehensive input validation and error handling
- **Authentication**: Support for API tokens and OAuth authentication
- **CORS Support**: Full cross-origin request support for browser extension integration

#### Architecture Improvements

- **Separation of Concerns**: Clear separation between build-time plugin and runtime server
- **Production Safety**: Server only runs in development environments
- **Single Instance**: File locking prevents multiple server instances
- **Environment Variables**: Comprehensive configuration through environment variables
- **Error Handling**: Robust error handling with detailed logging
- **Testing**: Complete test suite with 42 passing tests covering all functionality

#### Breaking Changes

- Removed database sync functionality (now handled by development server)
- Removed file mapping output (replaced with real-time processing)
- Changed API endpoint structure and request formats
- Updated environment variable names for consistency

### Version 0.8.0

- Added new `/get-changes` API endpoint for applying text-based changes to source files
- Implemented file mapping storage for tracking file identifiers
- Added integration with FastAPI backend for determining code changes
- Added Prettier formatting for updated files

### Version 0.7.0

- Added CLI tool for running the development server (`codepress` command)
- Added Visual Editor API endpoint (`/visual-editor-api`) for file updates from the browser extension
- Simplified server port configuration to use a fixed port (4321 by default) for reliability

### Version 0.6.0

- Added development server accessible via import '@quantfive/codepress-engine/server'
- Server automatically starts in development environments
- Includes port auto-detection and singleton pattern

### Version 0.5.0

- Removed hashing from repository and branch attributes for simpler integration
- Added restriction to only apply repository attributes to container elements (html, body, div)
- Simplified repository detection in the browser extension

## License

MIT

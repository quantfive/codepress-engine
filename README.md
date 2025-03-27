# @quantfive/codepress-engine

A Babel plugin that adds file identifiers to JSX elements for visual editing with Codepress.

## Installation

```bash
npm install --save-dev @quantfive/codepress-engine
```

## Usage

Add the plugin to your Babel configuration:

```javascript
// babel.config.js
module.exports = {
  plugins: [
    '@quantfive/codepress-engine'
  ]
};
```

### With options

```javascript
// babel.config.js
module.exports = {
  plugins: [
    ['@quantfive/codepress-engine', {
      // File output options
      outputPath: 'codepress-file-hash-map.json', // default: 'codepress-file-hash-map.json'
      
      // HTML attribute options
      attributeName: 'codepress-data-fp', // default: 'codepress-data-fp'
      repoAttributeName: 'codepress-github-repo-name', // default: 'codepress-github-repo-name'
      branchAttributeName: 'codepress-github-branch', // default: 'codepress-github-branch'
      
      // Database connection options 
      backendUrl: 'https://api.codepress.dev', // default: auto-detects based on environment
      repositoryId: 'owner/repo', // optional - auto-detects from git remote URL if not specified
      apiToken: 'your-api-token', // required for database saving
      branch: 'main', // optional - auto-detects from git if not specified
      environment: 'production' // optional - auto-detects based on NODE_ENV
    }]
  ]
};
```

### Backend Sync Configuration

For syncing with the CodePress backend, provide the connection details in your Babel config:

```javascript
module.exports = {
  plugins: [
    ['@quantfive/codepress-engine', {
      backendUrl: 'https://api.codepress.dev',
      repositoryId: 'owner/repo',
      apiToken: 'your-organization-api-key',
      branch: 'main',
      environment: 'production' // Explicitly set environment
    }]
  ]
};
```

The `apiToken` should be an Organization API Key created in the CodePress backend with `file_mappings` permission. This allows CI/CD systems to update file mappings without needing user credentials.

### Auto-detection Features

The plugin includes convenient auto-detection features to minimize configuration:

1. **Git Branch**: The plugin automatically detects the current git branch if the `branch` option is not specified. It uses `git rev-parse --abbrev-ref HEAD` to get the current branch name. If git is not available or the command fails, it will fall back to using `main` as the default branch.

2. **Repository ID**: The plugin automatically extracts the repository ID from your git remote URL if the `repositoryId` option is not specified. It parses the GitHub URL (both HTTPS and SSH formats are supported) to extract the owner and repository name in the format `owner/repo`. This works with URLs like:
   - `https://github.com/owner/repo.git`
   - `git@github.com:owner/repo.git`

These auto-detection features allow you to enable backend sync with minimal configuration:

```javascript
module.exports = {
  plugins: [
    ['@quantfive/codepress-engine', {
      apiToken: 'your-organization-api-key'
      // branch, repositoryId, and environment will be auto-detected
    }]
  ]
};
```

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
const { extractRepositoryInfo } = require('@quantfive/codepress-engine/hash-util');

// Automatically detect repository info from the DOM
function detectRepositoryInfo() {
  // Check root elements first (html, body, head)
  const rootElements = [
    document.documentElement, // html
    document.body,
    document.head
  ];
  
  // Look for repo attributes in root elements first
  for (const element of rootElements) {
    if (!element) continue;
    
    if (element.hasAttribute('codepress-github-repo-name')) {
      const repository = element.getAttribute('codepress-github-repo-name');
      const branch = element.getAttribute('codepress-github-branch') || 'main';
      
      return { repository, branch };
    }
  }
  
  // Fallback: Look for any elements with repo attributes
  const element = document.querySelector('[codepress-github-repo-name]');
  if (!element) return null;
  
  const repository = element.getAttribute('codepress-github-repo-name');
  const branch = element.getAttribute('codepress-github-branch') || 'main';
  
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

### Database Storage

The plugin will:

1. Collect file mappings throughout the build process
2. Save all file mappings to the CodePress database in a single bulk request
3. Make a POST request to `{backendUrl}/api/bulk-file-mappings` with all mappings at once
4. Include repository ID, branch, environment, and API key in the request
5. In development mode only, write to a local file as fallback if database save fails
6. Log detailed results including created and updated counts
7. Use throttling and retries to ensure reliable performance

This efficient batching approach minimizes API requests and improves build performance, especially for large projects with many files. The CodePress browser extension can then correlate DOM elements with source files when editing websites, without needing direct access to the source code.

#### How to Set Up Database Connection

1. In the CodePress backend, go to your GitHub organization settings
2. Navigate to the API Keys section
3. Create a new API key with `file_mappings` permission
4. Note the API key value (it will only be shown once)
5. Configure your build process with the API key:
   - Set `CODEPRESS_API_TOKEN` environment variable, or
   - Add the API key to your babel config
6. Set your environment:
   - For production: Set NODE_ENV=production or specify environment:'production' in options
   - For development: The default is 'development' if not specified

This allows your build system to automatically update file mappings with environment context whenever your code is built, keeping the CodePress database in sync with the latest file locations for both development and production environments.

## Development Server

This package includes a lightweight development server that can be started using our CLI tool or programmatically.

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
- `NODE_ENV`: Must be different from 'production' for the server to start

### Server Features

- Runs only in development environment
- Uses a fixed port (4321 by default) for predictable addressing
- Guards against multiple instances using a lock mechanism
- Provides useful endpoints:
  - `/ping` - Returns "pong" for health checks
  - `/meta` - Returns server metadata as JSON (includes version info)
  - `/visual-editor-api` - API endpoint for updating files from the visual editor
- Safe to use alongside your development tools

#### Visual Editor API

The server offers two key endpoints for visual editing:

##### 1. Register Files - `/visual-editor-api`

Allows the browser extension to register files and save images:

```
POST /visual-editor-api
Content-Type: application/json

{
  "id": "file-hash-identifier",
  "filePath": "src/components/Header.jsx",
  "newHtml": "<div>Updated HTML content</div>",
  "oldHtml": "<div>Original HTML content</div>",
  "imageData": "data:image/png;base64,iVBORw0KGgo...#filename=image.png"
}
```

Parameters:
- `id` (required): The file identifier hash
- `filePath` (optional): The relative path to the source file
- `newHtml` (required): The updated HTML content
- `oldHtml` (optional): The original HTML for verification
- `imageData` (optional): Base64-encoded image data with optional filename

The server will:
1. Store the file mapping if a path is provided
2. Process any included image data and save it to the project's public directory
3. Log information about the received update
4. Return a success response

##### 2. Apply Changes - `/get-changes`

Gets file changes from the backend API and applies them to the source file:

```
POST /get-changes
Content-Type: application/json

{
  "id": "file-hash-identifier",
  "oldHtml": "<div>Original HTML content</div>",
  "newHtml": "<div>Updated HTML content</div>"
}
```

Parameters:
- `id` (required): The file identifier hash
- `oldHtml` (required): The original HTML content
- `newHtml` (required): The updated HTML content

The server will:
1. Look up the file path from the stored mappings
2. Call the FastAPI backend's `/get-changes` endpoint to calculate text-based changes
3. Apply the changes to the source file
4. Format the code with Prettier
5. Return a success response with details about the applied changes

This endpoint provides a reliable way to update source files based on visual edits by:
- Using line-by-line text changes instead of AST transformations
- Handling edge cases like partial JSX fragments
- Preserving code formatting and style

### Programmatic Usage

For advanced use cases, you can also start the server programmatically:

```js
// Only use this in Node.js environments, not in browser code
const { startServer } = require('@quantfive/codepress-engine/server');

const server = startServer({
  port: 5678 // Optional custom port
});
```

> **Important**: The server module uses Node.js specific libraries and should only be imported in a Node.js environment, not in browser code. Use the CLI approach for the simplest integration.

## Changelog

### Version 0.8.0
- Added new `/get-changes` API endpoint for applying text-based changes to source files
- Implemented file mapping storage for tracking file identifiers
- Added integration with FastAPI backend for determining code changes
- Added Prettier formatting for updated files
- Enhanced CLI with new `setup` command for installing dependencies
- Added TypeScript type definitions for better developer experience
- Improved error handling for file operations and API requests
- Added comprehensive documentation for the visual editor API

### Version 0.7.0
- Added CLI tool for running the development server (`codepress` command)
- Added Visual Editor API endpoint (`/visual-editor-api`) for file updates from the browser extension
- Simplified server port configuration to use a fixed port (4321 by default) for reliability
- Added throttling and retry mechanisms for file mapping requests
- Improved reliability with automatic request retries on network failures
- Added exponential backoff to prevent overwhelming the server
- Enhanced error handling for authentication and server errors
- Fixed compatibility issues with webpack and browser environments

### Version 0.6.0
- Added development server accessible via import '@quantfive/codepress-engine/server'
- Server automatically starts in development environments
- Includes port auto-detection and singleton pattern

### Version 0.5.0
- Removed hashing from repository and branch attributes for simpler integration
- Added restriction to only apply repository attributes to container elements (html, body, div)
- Simplified repository detection in the browser extension
- Added support for automatic organization ID generation in the browser extension

### Version 0.4.3
- Added hashing for repository and branch information
- Improved repository and branch auto-detection
- Added bulk API request for file mappings

## License

MIT
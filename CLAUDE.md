# codepress-engine Development Guide

## Build & Test Commands

- **Build**: `npm run build`
- **Test (All)**: `npm test`
- **Test (Single)**: `npx jest test/index.test.js -t "test description"`
- **Test Server**: `npx jest test/server.test.js`
- **Lint**: `npm run lint` (or `npm run lint:fix` to auto-fix)
- **Format**: `npm run format` (or `npm run format:check` to check only)
- **Quality**: `npm run quality` (runs lint, format check, and tests)

## Code Style Guidelines

### JavaScript

- **Imports**: Group NodeJS core modules first, then third-party, then local
- **Naming**: camelCase for variables/functions, PascalCase for classes
- **Functions**: Use named function expressions with JSDoc comments
- **Error Handling**: Use try/catch blocks with descriptive error messages
- **Formatting**: 2-space indentation, use semicolons for clarity
- **Style**: Follow Node.js idiomatic patterns, prefer async/await over promises
- **Types**: Include JSDoc type annotations for function parameters/returns

### Plugin Configuration (index.js)

- Pass configuration options directly to the Babel plugin
- Auto-detect git branch and repository information when possible
- Use sensible defaults for optional parameters
- Document all options using JSDoc format
- Validate and normalize options
- Provide clear console feedback with colored output

### Server Architecture (server.js)

- Use Fastify for high-performance HTTP server
- Implement comprehensive request validation
- Handle errors gracefully with proper HTTP status codes
- Use service functions to separate concerns
- Implement proper authentication and CORS handling
- Format code with Prettier after modifications

### Testing

- Write unit tests for all public functions
- Mock external dependencies (fs, os, node-fetch, prettier)
- Tests should be isolated and not depend on environment
- Test both success and error scenarios
- Use proper Jest mocking patterns
- Verify all API endpoints and text change operations

## Recent Changes

### v1.0.0 (Current - Major Rewrite)

**Complete architectural overhaul with separation of concerns between build-time plugin and runtime server.**

#### Babel Plugin (index.js)

- **Encoding System**: Implements XOR encryption for file paths with URL-safe base64 encoding
- **Line-Based Mapping**: Each JSX element includes precise line number ranges (startLine-endLine)
- **Auto-Detection Only**: Always detects branch and repository from git configuration - no manual override
- **Container Attributes**: Repository and branch information added only to container elements
- **Performance Optimization**: Streamlined build process with minimal overhead and zero configuration
- **Production Ready**: Safe for production use with no external dependencies during build

#### Development Server (server.js)

- **Fastify Framework**: High-performance HTTP server with CORS support
- **Dual API Endpoints**: Separate endpoints for regular edits (`/visual-editor-api`) and AI edits (`/visual-editor-api-ai`)
- **Text Change Engine**: Advanced system supporting insert, delete, and replace operations
- **Backend Integration**: Seamless communication with Codepress backend API
- **Image Processing**: Automatic image saving from visual editor to public directory
- **Code Formatting**: Prettier integration for consistent code formatting
- **Request Validation**: Comprehensive input validation and error handling
- **Authentication**: Support for API tokens and OAuth authentication
- **File Locking**: Single instance operation with lock file mechanism
- **Environment Safety**: Only runs in development environments

#### Architecture Improvements

- **Service Layer**: Clean separation of concerns with dedicated service functions
- **Error Handling**: Comprehensive error handling with detailed logging
- **Environment Configuration**: Full configuration through environment variables
- **Testing Coverage**: Complete test suite with 42 passing tests (17 server + 25 plugin)
- **Type Safety**: JSDoc annotations throughout codebase
- **Security**: File path encoding prevents exposure of project structure

#### Breaking Changes from v0.5.0

- Removed database sync functionality (replaced with real-time processing)
- Removed file mapping output (replaced with encoded attributes)
- Changed API endpoint structure and request formats
- Updated environment variable names for consistency
- Removed hash-util.js (functionality moved to index.js)

### Integration with Browser Extension

- **Real-Time Processing**: No pre-built file mappings required
- **Encoded Attributes**: Secure file path encoding in DOM attributes
- **Repository Detection**: Automatic repository and branch detection from DOM
- **Visual Editor API**: Direct communication with development server
- **Image Support**: Full image upload and processing support
- **AI Integration**: Built-in AI-powered editing capabilities

## Testing Strategy

### Plugin Tests (test/index.test.js)

- **Core Functionality**: JSX attribute injection with line numbers
- **Git Detection**: Branch and repository URL parsing
- **Encoding/Decoding**: File path security and URL-safe formatting
- **Production Mode**: Safe operation in production environments
- **File Processing**: Node modules exclusion and file counting

### Server Tests (test/server.test.js)

- **API Endpoints**: All visual editor API endpoints
- **Text Operations**: Insert, delete, and replace text changes
- **Request Validation**: Input validation for both regular and AI modes
- **Image Handling**: Base64 image processing and file saving
- **Backend Communication**: API integration with authentication
- **Error Scenarios**: Comprehensive error handling testing

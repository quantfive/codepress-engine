# babel-plugin-codepress-html Development Guide

## Build & Test Commands
- **Build**: `npm run build` 
- **Test (All)**: `npm test`
- **Test (Single)**: `npx jest test/index.test.js -t "test description"`
- **Lint**: `npx eslint src/` (add eslint with: `npm i -D eslint`)

## Code Style Guidelines

### JavaScript
- **Imports**: Group NodeJS core modules first, then third-party, then local
- **Naming**: camelCase for variables/functions, PascalCase for classes
- **Functions**: Use named function expressions with JSDoc comments
- **Error Handling**: Use try/catch blocks with descriptive error messages
- **Formatting**: 2-space indentation, no semicolons
- **Style**: Follow Node.js idiomatic patterns, avoid complex operations
- **Types**: Include JSDoc type annotations for function parameters/returns

### Plugin Configuration
- Pass configuration options directly to the Babel plugin
- Auto-detect git branch and repository information when possible
- Use sensible defaults for optional parameters
- Document all options using JSDoc format
- Validate and normalize options
- Provide clear console feedback with colored output

### Testing
- Write unit tests for all public functions
- Mock external dependencies (fs, http)
- Tests should be isolated and not depend on environment

## Recent Changes

### v0.5.0 (Current)
- Removed hashing from repository and branch attributes for easier debugging and integration
- Now directly injects the repository and branch in plain text
- Added restriction to only inject repository data on container elements (html, body, div)
- Updated browser extension code to work without requiring organization selection
- Added utilities to derive organization information from repository data
- Simplified repository detection in the browser extension

### Integration with Browser Extension
- The browser extension now automatically detects repository information from the DOM
- No longer requires manual repository/organization selection
- Uses the repository owner as a fallback organization name
- Generates a deterministic ID from the repository owner when real organization ID is unavailable

## Changelog

### v0.5.0
1. **Main Babel Plugin (index.js)**
   - Removed hashing for repository and branch attributes
   - Added constraint to only add attributes to container elements (html, body, div)
   - Improved logging to show which element type gets the attributes

2. **Hash Utility (hash-util.js)**
   - Updated to handle non-hashed repository/branch values
   - Maintained backward compatibility for projects using older versions

3. **Browser Extension Integration**
   - Added parseRepositoryName utility to extract owner/repo from repository string
   - Added createPseudoOrganization utility to generate organization info from owner
   - Updated App.tsx to work with auto-detected repositories
   - Modified ApiKeyGenerator to accept repositoryName
   - Updated test suite to match new behavior

### v0.4.3
- Added hashing for repository and branch information
- Improved repository and branch auto-detection
- Added bulk API request for file mappings
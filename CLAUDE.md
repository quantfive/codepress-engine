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
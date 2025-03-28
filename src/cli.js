#!/usr/bin/env node

// Codepress CLI
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./server');
const fetch = require('node-fetch');
const crypto = require('crypto');

// Get command line arguments
const args = process.argv.slice(2);

// Frontend file extensions to process
const FRONTEND_EXTENSIONS = [
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'
];

// Directories to ignore
const IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  'coverage', '.cache', '.husky', '.github'
];

/**
 * Recursively scans a directory for frontend code files
 * @param {string} dir - Directory to scan
 * @param {Set} resultSet - Set to collect found files
 * @param {string} baseDir - Original base directory path for creating relative paths
 * @param {Array} ignoreDirs - Optional array of directories to ignore (overrides IGNORE_DIRS)
 */
function scanDirectory(dir, resultSet, baseDir, ignoreDirs = null) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  const dirsToIgnore = ignoreDirs || IGNORE_DIRS;
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    const relativePath = path.relative(baseDir, filePath);
    
    // Skip ignored directories
    if (file.isDirectory()) {
      const shouldIgnore = dirsToIgnore.some(ignoreDir => {
        // Ensure ignoreDir has a leading slash for proper matching
        const normalizedIgnoreDir = ignoreDir.startsWith('/') ? ignoreDir : `/${ignoreDir}`;
        // Match either full path components or at the end of the path
        return filePath.includes(normalizedIgnoreDir + '/') || 
               filePath.endsWith(normalizedIgnoreDir);
      });
      
      if (!shouldIgnore) {
        scanDirectory(filePath, resultSet, baseDir, ignoreDirs);
      }
      continue;
    }
    
    // Check file extension
    const ext = path.extname(file.name).toLowerCase();
    if (FRONTEND_EXTENSIONS.includes(ext)) {
      resultSet.add(relativePath);
    }
  }
}

/**
 * Initialize a project with Codepress for component analysis
 * Creates the necessary configuration files and performs initial scan
 */
function initProject() {
  console.log('\x1b[36mℹ Initializing Codepress component analysis...\x1b[0m');
  
  try {
    // 1. Create codepress.json configuration file (optional)
    const configPath = path.join(process.cwd(), 'codepress.json');
    let configExists = false;
    let config = {
      version: '1.0.0',
      scanDirectories: ['.'], // Scan entire project by default
      excludeDirectories: IGNORE_DIRS,
      fileExtensions: FRONTEND_EXTENSIONS,
      backendUrl: 'http://localhost:8000'
    };
    
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        configExists = true;
        console.log('\x1b[36mℹ Existing configuration found, updating...\x1b[0m');
      } catch (err) {
        console.log('\x1b[33m⚠ Couldn\'t parse existing config, creating new one\x1b[0m');
      }
    }
    
    // Write the config file
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`\x1b[32m✓ ${configExists ? 'Updated' : 'Created'} Codepress configuration\x1b[0m`);
    console.log('\x1b[36mℹ Note: The configuration file is optional and can be deleted if you prefer automatic detection\x1b[0m');
    
    // 2. Create .env file if it doesn't exist
    const envPath = path.join(process.cwd(), '.env');
    let envContent = '';
    let envExists = false;
    
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
      envExists = true;
    }
    
    // Add environment variables if they don't exist
    let envUpdated = false;
    
    if (!envContent.includes('CODEPRESS_BACKEND_HOST')) {
      envContent += '\n# Codepress backend settings\n';
      envContent += 'CODEPRESS_BACKEND_HOST=localhost\n';
      envContent += 'CODEPRESS_BACKEND_PORT=8000\n';
      envUpdated = true;
    }
    
    if (!envContent.includes('CODEPRESS_API_TOKEN')) {
      envContent += '\n# Codepress authentication\n';
      envContent += '# Get this from your organization settings in Codepress\n';
      envContent += 'CODEPRESS_API_TOKEN=\n';
      envUpdated = true;
    }
    
    if (envUpdated) {
      fs.writeFileSync(envPath, envContent);
      console.log(`\x1b[32m✓ ${envExists ? 'Updated' : 'Created'} environment configuration\x1b[0m`);
      console.log('\x1b[33m⚠ Please set your CODEPRESS_API_TOKEN in the .env file\x1b[0m');
    }
    
    // 3. Create a sample component analysis script
    const scriptsDir = path.join(process.cwd(), 'scripts');
    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }
    
    const scanScriptPath = path.join(scriptsDir, 'scan-components.js');
    const scanScript = `#!/usr/bin/env node

// Component Scanner for Codepress
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

// Load configuration (if exists)
let config = {
  scanDirectories: ['.'],
  excludeDirectories: [
    'node_modules', '.git', 'dist', 'build', 'out', '.next',
    'coverage', '.cache', '.husky', '.github'
  ],
  fileExtensions: [
    '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'
  ]
};

try {
  const configPath = path.join(__dirname, '..', 'codepress.json');
  if (fs.existsSync(configPath)) {
    const userConfig = require('../codepress.json');
    config = { ...config, ...userConfig };
    console.log('\\x1b[36mℹ Using configuration from codepress.json\\x1b[0m');
  } else {
    console.log('\\x1b[36mℹ No configuration file found, using defaults\\x1b[0m');
  }
} catch (error) {
  console.log(\`\\x1b[33m⚠ Error loading configuration: \${error.message}\\x1b[0m\`);
  console.log('\\x1b[36mℹ Using default configuration\\x1b[0m');
}

const dotenv = require('dotenv');
dotenv.config();

// Frontend file extensions to process
const FRONTEND_EXTENSIONS = config.fileExtensions || [
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'
];

// Directories to ignore
const IGNORE_DIRS = config.excludeDirectories || [
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  'coverage', '.cache', '.husky', '.github'
];

/**
 * Recursively scans a directory for frontend code files
 * @param {string} dir - Directory to scan
 * @param {Set} resultSet - Set to collect found files
 * @param {string} baseDir - Original base directory path for creating relative paths
 */
function scanDirectory(dir, resultSet, baseDir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    const relativePath = path.relative(baseDir, filePath);
    
    // Skip ignored directories
    if (file.isDirectory()) {
      const shouldIgnore = IGNORE_DIRS.some(ignoreDir => {
        // Ensure ignoreDir has a leading slash for proper matching
        const normalizedIgnoreDir = ignoreDir.startsWith('/') ? ignoreDir : \`/\${ignoreDir}\`;
        // Match either full path components or at the end of the path
        return filePath.includes(normalizedIgnoreDir + '/') || 
               filePath.endsWith(normalizedIgnoreDir);
      });
      
      if (!shouldIgnore) {
        scanDirectory(filePath, resultSet, baseDir);
      }
      continue;
    }
    
    // Check file extension
    const ext = path.extname(file.name).toLowerCase();
    if (FRONTEND_EXTENSIONS.includes(ext)) {
      resultSet.add(relativePath);
    }
  }
}

/**
 * Main function to scan components and send to backend
 */
async function scanComponents() {
  console.log('\\x1b[36mℹ Scanning frontend components...\\x1b[0m');
  
  const cwd = process.cwd();
  const foundFiles = new Set();
  
  // Scan directories defined in config
  const scanDirs = config.scanDirectories || ['.'];
  
  // Display scanning mode
  if (scanDirs.includes('.')) {
    console.log('\\x1b[36mℹ Scanning mode: Full project scan (except excluded directories)\\x1b[0m');
  } else {
    console.log(\`\\x1b[36mℹ Scanning mode: Specific directories: \${scanDirs.join(', ')}\\x1b[0m\`);
  }
  
  // Ensure all excluded directories are prefixed with '/'
  const normalizedExcludeDirs = (config.excludeDirectories || IGNORE_DIRS).map(dir => 
    dir.startsWith('/') ? dir : \`/\${dir}\`
  );
  console.log(\`\\x1b[36mℹ Excluded directories: \${normalizedExcludeDirs.join(', ')}\\x1b[0m\`);
  
  // Update IGNORE_DIRS to use normalized values
  IGNORE_DIRS.splice(0, IGNORE_DIRS.length, ...normalizedExcludeDirs);
  
  for (const dir of scanDirs) {
    const baseDir = path.resolve(cwd, dir);
    try {
      if (fs.existsSync(baseDir)) {
        scanDirectory(baseDir, foundFiles, cwd);
      } else {
        console.log(\`\\x1b[33m⚠ Directory not found: \${baseDir}\\x1b[0m\`);
      }
    } catch (error) {
      console.error(\`\\x1b[31m✗ Error scanning directory \${baseDir}: \${error.message}\\x1b[0m\`);
    }
  }
  
  if (foundFiles.size === 0) {
    console.log('\\x1b[33m⚠ No frontend code files found\\x1b[0m');
    return;
  }
  
  console.log(\`\\x1b[32m✓ Found \${foundFiles.size} frontend code files\\x1b[0m\`);
  
  // Detect git info
  let repoInfo = {};
  try {
    const branch = require('child_process').execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();
    
    const remoteUrl = require('child_process').execSync("git config --get remote.origin.url", {
      encoding: "utf8",
    }).trim();
    
    let owner, repo;
    const httpsMatch = remoteUrl.match(/https:\\/\\/github\\.com\\/([^\\/]+)\\/([^\\/\\.]+)(?:\\.git)?$/);
    const sshMatch = remoteUrl.match(/git@github\\.com:([^\\/]+)\\/([^\\/\\.]+)(?:\\.git)?$/);
    
    if (httpsMatch) {
      [, owner, repo] = httpsMatch;
    } else if (sshMatch) {
      [, owner, repo] = sshMatch;
    }
    
    if (owner && repo) {
      repoInfo = {
        repository: \`\${owner}/\${repo}\`,
        branch: branch || 'main'
      };
      console.log(\`\\x1b[32m✓ Detected repository: \${repoInfo.repository} (\${repoInfo.branch})\\x1b[0m\`);
    }
  } catch (error) {
    console.log('\\x1b[33m⚠ Could not detect git repository information\\x1b[0m');
  }
  
  // Process files
  console.log('\\x1b[36mℹ Processing files and generating component data...\\x1b[0m');
  const components = [];
  const totalFiles = foundFiles.size;
  let processedCount = 0;
  
  for (const relFilePath of foundFiles) {
    const fullPath = path.join(cwd, relFilePath);
    
    try {
      // Read file content
      const content = fs.readFileSync(fullPath, 'utf8');
      
      // Create a file hash
      const fileHash = crypto
        .createHash("sha1")
        .update(relFilePath)
        .digest("hex")
        .substring(0, 8);
        
      // Create component data
      components.push({
        file_path: relFilePath,
        hash_id: fileHash,
        content,
        repository: repoInfo.repository || null,
        branch: repoInfo.branch || null
      });
      
      // Show progress
      processedCount++;
      if (processedCount % 10 === 0 || processedCount === totalFiles) {
        process.stdout.write(\`\\r\\x1b[36mℹ Processed \${processedCount}/\${totalFiles} files\\x1b[0m\`);
      }
    } catch (error) {
      console.error(\`\\x1b[31m✗ Error processing \${relFilePath}: \${error.message}\\x1b[0m\`);
    }
  }
  
  console.log('\\n\\x1b[32m✓ Completed processing all files\\x1b[0m');
  
  // Send data to backend
  console.log('\\x1b[36mℹ Sending data to backend for component analysis...\\x1b[0m');
  
  // Extract backend settings
  const backendHost = process.env.CODEPRESS_BACKEND_HOST || 'localhost';
  const backendPort = parseInt(process.env.CODEPRESS_BACKEND_PORT || '8000', 10);
  const apiToken = process.env.CODEPRESS_API_TOKEN;
  
  // Build API URL
  const protocol = backendHost === 'localhost' || backendHost === '127.0.0.1' ? 'http' : 'https';
  const backendUrl = \`\${protocol}://\${backendHost}\${backendPort ? \`:\${backendPort}\` : ''}\`;
  const endpoint = \`\${backendUrl}/api/component-analysis\`;
  
  try {
    // Prepare headers
    const headers = {
      'Content-Type': 'application/json',
    };
    
    if (apiToken) {
      headers['Authorization'] = \`Bearer \${apiToken}\`;
    } else {
      console.log('\\x1b[33m⚠ No API token provided, authentication may fail\\x1b[0m');
    }
    
    // Send the component data to backend
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        components,
        repository: repoInfo.repository || null,
        branch: repoInfo.branch || null
      }),
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log(\`\\x1b[32m✓ Successfully sent \${components.length} components to backend\\x1b[0m\`);
      console.log(\`\\x1b[32m✓ Analysis ID: \${result.analysis_id}\\x1b[0m\`);
      
      if (result.reusable_patterns && result.reusable_patterns.length > 0) {
        console.log('\\n\\x1b[1mIdentified Reusable Components:\\x1b[0m');
        result.reusable_patterns.forEach((pattern, index) => {
          console.log(\`  \${index + 1}. \${pattern.name} (\${pattern.files.length} occurrences)\`);
        });
      }
    } else {
      const errorText = await response.text();
      console.error(\`\\x1b[31m✗ Backend request failed (\${response.status}): \${errorText}\\x1b[0m\`);
    }
  } catch (error) {
    console.error(\`\\x1b[31m✗ Error sending data to backend: \${error.message}\\x1b[0m\`);
  }
}

// Run the main function
scanComponents().catch(error => {
  console.error(\`\\x1b[31m✗ Fatal error: \${error.message}\\x1b[0m\`);
  process.exit(1);
});
`;
    
    fs.writeFileSync(scanScriptPath, scanScript);
    fs.chmodSync(scanScriptPath, '755');
    console.log('\x1b[32m✓ Created component scanner script\x1b[0m');
    
    // 4. Add script to package.json
    try {
      const packageJsonPath = path.join(process.cwd(), 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        
        if (!packageJson.scripts) {
          packageJson.scripts = {};
        }
        
        packageJson.scripts['codepress:scan'] = 'node ./scripts/scan-components.js';
        
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
        console.log('\x1b[32m✓ Added scan script to package.json\x1b[0m');
      }
    } catch (error) {
      console.log(`\x1b[33m⚠ Couldn't update package.json: ${error.message}\x1b[0m`);
      console.log('\x1b[33m⚠ Please add this script manually to your package.json:\x1b[0m');
      console.log('  "scripts": {');
      console.log('    "codepress:scan": "node ./scripts/scan-components.js"');
      console.log('  }');
    }
    
    // 5. Install required dependencies
    try {
      console.log('\x1b[36mℹ Installing required dependencies...\x1b[0m');
      execSync('npm install --save-dev dotenv node-fetch@^2.6.7', { stdio: 'inherit' });
      console.log('\x1b[32m✓ Installed dependencies\x1b[0m');
    } catch (error) {
      console.log(`\x1b[33m⚠ Couldn't install dependencies: ${error.message}\x1b[0m`);
      console.log('\x1b[33m⚠ Please install them manually:\x1b[0m');
      console.log('  npm install --save-dev dotenv node-fetch@^2.6.7');
    }
    
    // 6. Perform initial scan if backend URL is valid
    console.log('\x1b[36mℹ Setup complete!\x1b[0m');
    console.log('\x1b[36mℹ To scan your components, run:\x1b[0m');
    console.log('  npm run codepress:scan');
  } catch (error) {
    console.error(`\x1b[31m✗ Initialization failed: ${error.message}\x1b[0m`);
    // Only exit if we're in a real CLI environment, not during tests
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1);
    }
  }
}

// Command functions
function runServer() {
  const server = startServer();
  console.log('\x1b[36mℹ Codepress server running. Press Ctrl+C to stop.\x1b[0m');
  
  // Handle process signals
  process.on('SIGINT', () => {
    console.log('\n\x1b[33mℹ Shutting down Codepress server...\x1b[0m');
    if (server) {
      server.close(() => {
        console.log('\x1b[32m✓ Codepress server stopped\x1b[0m');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
  
  return server;
}

function setupDependencies() {
  console.log('\x1b[36mℹ Setting up dependencies for Codepress visual editor...\x1b[0m');
  
  try {
    console.log('\x1b[36mℹ Installing dependencies...\x1b[0m');
    execSync('npm install --save prettier@^3.1.0 node-fetch@^2.6.7', { stdio: 'inherit' });
    
    console.log('\n\x1b[36mℹ Setting up environment variables...\x1b[0m');
    const envFile = path.join(process.cwd(), '.env');
    
    let envContent = '';
    if (fs.existsSync(envFile)) {
      envContent = fs.readFileSync(envFile, 'utf8');
    }
    
    // Add environment variables if they don't exist
    let envUpdated = false;
    
    if (!envContent.includes('CODEPRESS_BACKEND_HOST')) {
      envContent += '\n# Codepress backend settings\n';
      envContent += 'CODEPRESS_BACKEND_HOST=localhost\n';
      envContent += 'CODEPRESS_BACKEND_PORT=8000\n';
      envUpdated = true;
    }
    
    if (!envContent.includes('CODEPRESS_API_TOKEN')) {
      envContent += '\n# Codepress authentication\n';
      envContent += '# Get this from your organization settings in Codepress\n';
      envContent += 'CODEPRESS_API_TOKEN=\n';
      envUpdated = true;
    }
    
    if (envUpdated) {
      fs.writeFileSync(envFile, envContent);
      console.log('\x1b[32m✓ Added Codepress settings to .env file\x1b[0m');
      console.log('\x1b[33m⚠ Please set your CODEPRESS_API_TOKEN in the .env file\x1b[0m');
    }
    
    console.log('\n\x1b[32m✅ Setup completed successfully!\x1b[0m');
    console.log('\x1b[36mℹ You can now start the server with: npx codepress server\x1b[0m');
  } catch (error) {
    console.error(`\n\x1b[31m✗ Setup failed: ${error.message}\x1b[0m`);
    // Only exit if we're in a real CLI environment, not during tests
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1);
    }
  }
}

function showHelp() {
  console.log(`
\x1b[1mCodepress CLI\x1b[0m

\x1b[1mUsage:\x1b[0m
  codepress [command] [args...]

\x1b[1mCommands:\x1b[0m
  server          Start the development server
  setup           Setup dependencies for the visual editor
  init            Initialize component scanning in this project (creates config files)
  scan [dir]      Scan and analyze frontend components (dir defaults to .)
  <command>       Run any command with the server running in background
  help            Show this help message

\x1b[1mExamples:\x1b[0m
  codepress server              Start the server only
  codepress setup               Install required dependencies
  codepress init                Initialize component scanning
  codepress scan                Scan all frontend files in current directory
  codepress scan src            Scan only frontend files in src directory
  codepress npm start           Run npm start with server in background
  `);
}

/**
 * Run component scan directly without requiring project initialization
 * @param {string} targetDir - Optional target directory to scan (defaults to cwd)
 */
async function scanComponents(targetDir = '.') {
  console.log('\x1b[36mℹ Starting component scan...\x1b[0m');
  
  // Prepare scan environment
  const dotenvPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(dotenvPath)) {
    try {
      // Try to load dotenv if available
      require('dotenv').config();
      console.log('\x1b[36mℹ Loaded environment from .env file\x1b[0m');
    } catch (error) {
      console.log('\x1b[33m⚠ Could not load dotenv, continuing without it\x1b[0m');
    }
  } else {
    console.log('\x1b[36mℹ No .env file found, using default settings\x1b[0m');
  }
  
  // Load config if it exists
  let config = {
    scanDirectories: [targetDir],
    excludeDirectories: IGNORE_DIRS,
    fileExtensions: FRONTEND_EXTENSIONS
  };
  
  const configPath = path.join(process.cwd(), 'codepress.json');
  if (fs.existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = { ...config, ...userConfig };
      console.log('\x1b[36mℹ Using configuration from codepress.json\x1b[0m');
    } catch (error) {
      console.log(`\x1b[33m⚠ Could not parse codepress.json: ${error.message}\x1b[0m`);
      console.log('\x1b[36mℹ Using default configuration\x1b[0m');
    }
  } else {
    console.log('\x1b[36mℹ No configuration file found, using default settings\x1b[0m');
  }
  
  // Start scanning
  console.log('\x1b[36mℹ Scanning frontend components...\x1b[0m');
  
  const cwd = process.cwd();
  const foundFiles = new Set();
  
  // Scan directories defined in config (or use targetDir)
  const scanDirs = config.scanDirectories || [targetDir];
  
  // Display scanning mode
  if (scanDirs.some(dir => dir === '.' || dir === './')) {
    console.log('\x1b[36mℹ Scanning mode: Full project scan (except excluded directories)\x1b[0m');
  } else {
    console.log(`\x1b[36mℹ Scanning mode: Specific directories: ${scanDirs.join(', ')}\x1b[0m`);
  }
  
  // Normalize excluded directories
  const normalizedExcludeDirs = (config.excludeDirectories || IGNORE_DIRS).map(dir => 
    dir.startsWith('/') ? dir : `/${dir}`
  );
  console.log(`\x1b[36mℹ Excluded directories: ${normalizedExcludeDirs.join(', ')}\x1b[0m`);
  
  // Update IGNORE_DIRS for use in scanDirectory
  const tempIgnoreDirs = [...normalizedExcludeDirs];
  
  // Scan directories
  for (const dir of scanDirs) {
    const baseDir = path.resolve(cwd, dir);
    try {
      if (fs.existsSync(baseDir)) {
        scanDirectory(baseDir, foundFiles, cwd, tempIgnoreDirs);
      } else {
        console.log(`\x1b[33m⚠ Directory not found: ${baseDir}\x1b[0m`);
      }
    } catch (error) {
      console.error(`\x1b[31m✗ Error scanning directory ${baseDir}: ${error.message}\x1b[0m`);
    }
  }
  
  if (foundFiles.size === 0) {
    console.log('\x1b[33m⚠ No frontend code files found\x1b[0m');
    return;
  }
  
  console.log(`\x1b[32m✓ Found ${foundFiles.size} frontend code files\x1b[0m`);
  
  // Detect git info
  let repoInfo = {};
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();
    
    const remoteUrl = execSync("git config --get remote.origin.url", {
      encoding: "utf8",
    }).trim();
    
    let owner, repo;
    const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^\/]+)\/([^\/\.]+)(?:\.git)?$/);
    const sshMatch = remoteUrl.match(/git@github\.com:([^\/]+)\/([^\/\.]+)(?:\.git)?$/);
    
    if (httpsMatch) {
      [, owner, repo] = httpsMatch;
    } else if (sshMatch) {
      [, owner, repo] = sshMatch;
    }
    
    if (owner && repo) {
      repoInfo = {
        repository: `${owner}/${repo}`,
        branch: branch || 'main'
      };
      console.log(`\x1b[32m✓ Detected repository: ${repoInfo.repository} (${repoInfo.branch})\x1b[0m`);
    }
  } catch (error) {
    console.log('\x1b[33m⚠ Could not detect git repository information\x1b[0m');
  }
  
  // Process files
  console.log('\x1b[36mℹ Processing files and generating component data...\x1b[0m');
  const components = [];
  const totalFiles = foundFiles.size;
  let processedCount = 0;
  
  for (const relFilePath of foundFiles) {
    const fullPath = path.join(cwd, relFilePath);
    
    try {
      // Read file content
      const content = fs.readFileSync(fullPath, 'utf8');
      
      // Create a file hash
      const fileHash = crypto
        .createHash("sha1")
        .update(relFilePath)
        .digest("hex")
        .substring(0, 8);
        
      // Create component data
      components.push({
        file_path: relFilePath,
        hash_id: fileHash,
        content,
        repository: repoInfo.repository || null,
        branch: repoInfo.branch || null
      });
      
      // Show progress
      processedCount++;
      if (processedCount % 10 === 0 || processedCount === totalFiles) {
        process.stdout.write(`\r\x1b[36mℹ Processed ${processedCount}/${totalFiles} files\x1b[0m`);
      }
    } catch (error) {
      console.error(`\x1b[31m✗ Error processing ${relFilePath}: ${error.message}\x1b[0m`);
    }
  }
  
  console.log('\n\x1b[32m✓ Completed processing all files\x1b[0m');
  
  // Send data to backend
  console.log('\x1b[36mℹ Sending data to backend for component analysis...\x1b[0m');
  
  // Extract backend settings
  const backendHost = process.env.CODEPRESS_BACKEND_HOST || 'localhost';
  const backendPort = parseInt(process.env.CODEPRESS_BACKEND_PORT || '8000', 10);
  const apiToken = process.env.CODEPRESS_API_TOKEN;
  
  // Build API URL
  const protocol = backendHost === 'localhost' || backendHost === '127.0.0.1' ? 'http' : 'https';
  const backendUrl = `${protocol}://${backendHost}${backendPort ? `:${backendPort}` : ''}`;
  const endpoint = `${backendUrl}/api/component-analysis`;
  
  try {
    // Prompt for API token if not found
    let authToken = apiToken;
    if (!authToken) {
      console.log('\x1b[33m⚠ No API token found in environment\x1b[0m');
      console.log('\x1b[36mℹ You can set it in .env file or run: export CODEPRESS_API_TOKEN=your_token\x1b[0m');
    }
    
    // Prepare headers
    const headers = {
      'Content-Type': 'application/json',
    };
    
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    } else {
      console.log('\x1b[33m⚠ No API token provided, authentication may fail\x1b[0m');
    }
    
    // Send the component data to backend
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        components,
        repository: repoInfo.repository || null,
        branch: repoInfo.branch || null
      }),
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log(`\x1b[32m✓ Successfully sent ${components.length} components to backend\x1b[0m`);
      console.log(`\x1b[32m✓ Analysis ID: ${result.analysis_id}\x1b[0m`);
      
      if (result.reusable_patterns && result.reusable_patterns.length > 0) {
        console.log('\n\x1b[1mIdentified Reusable Components:\x1b[0m');
        result.reusable_patterns.forEach((pattern, index) => {
          console.log(`  ${index + 1}. ${pattern.name} (${pattern.files.length} occurrences)`);
        });
      }
    } else {
      const errorText = await response.text();
      console.error(`\x1b[31m✗ Backend request failed (${response.status}): ${errorText}\x1b[0m`);
    }
  } catch (error) {
    console.error(`\x1b[31m✗ Error sending data to backend: ${error.message}\x1b[0m`);
  }
}

// Command router
if (args.length > 0) {
  const command = args[0];
  
  switch (command) {
    case 'server':
      runServer();
      break;
      
    case 'setup':
      setupDependencies();
      break;
      
    case 'init':
      initProject();
      break;
      
    case 'scan':
      // Optional target directory (defaults to current directory)
      const targetDir = args[1] || '.';
      scanComponents(targetDir);
      break;
      
    case 'help':
      showHelp();
      break;
      
    default:
      // Start server and pass through all arguments to child process
      const server = startServer();
      
      const childProcess = spawn(args[0], args.slice(1), {
        stdio: 'inherit',
        shell: true
      });
      
      childProcess.on('error', (error) => {
        console.error(`\x1b[31m✗ Failed to start process: ${error.message}\x1b[0m`);
        process.exit(1);
      });
      
      childProcess.on('close', (code) => {
        console.log(`\x1b[33mℹ Child process exited with code ${code}\x1b[0m`);
        // Keep the server running even if the child process exits
      });
      
      // Handle process signals
      process.on('SIGINT', () => {
        console.log('\n\x1b[33mℹ Shutting down Codepress server...\x1b[0m');
        if (server) {
          server.close(() => {
            console.log('\x1b[32m✓ Codepress server stopped\x1b[0m');
            process.exit(0);
          });
        } else {
          process.exit(0);
        }
      });
  }
} else {
  // No arguments provided, show help
  showHelp();
}
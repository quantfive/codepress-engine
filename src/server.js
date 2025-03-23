// Codepress Dev Server
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')

/**
 * Gets a usable port, starting from the specified port and incrementing if needed
 * @param {number} startPort - The port to try first
 * @param {number} maxAttempts - Maximum number of ports to try
 * @returns {Promise<number>} A usable port
 */
async function getAvailablePort(startPort, maxAttempts = 10) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = startPort + attempt
    try {
      // Create a test server to check if port is available
      const server = http.createServer()
      
      const available = await new Promise((resolve) => {
        server.once('error', () => {
          server.close()
          resolve(false)
        })
        
        server.once('listening', () => {
          server.close(() => resolve(true))
        })
        
        server.listen(port)
      })
      
      if (available) {
        return port
      }
    } catch (err) {
      // Continue to next port on error
      continue
    }
  }
  
  // If all attempts failed, return the last attempted port
  return startPort + maxAttempts - 1
}

/**
 * Create a lock file to ensure only one instance runs
 * @returns {boolean} True if lock was acquired, false otherwise
 */
function acquireLock() {
  try {
    const lockPath = path.join(os.tmpdir(), 'codepress-dev-server.lock')
    
    // Try to read the lock file to check if the server is already running
    const lockData = fs.existsSync(lockPath) ? 
      JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null
    
    if (lockData) {
      // Check if the process in the lock file is still running
      try {
        // On Unix-like systems, sending signal 0 checks if process exists
        process.kill(lockData.pid, 0)
        // Process exists, lock is valid
        return false
      } catch (e) {
        // Process doesn't exist, lock is stale
        // Continue to create a new lock
      }
    }
    
    // Create a new lock file
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      timestamp: Date.now()
    }))
    
    return true
  } catch (err) {
    // If anything fails, assume we couldn't get the lock
    return false
  }
}

// Track server instance (singleton pattern)
let serverInstance = null

/**
 * Starts the Codepress development server if not already running
 * @param {Object} options Server configuration options
 * @param {number} [options.port=4321] Port to run the server on
 * @returns {http.Server|null} The server instance or null if already running
 */
function startServer(options = {}) {
  // Only run in development environment
  if (process.env.NODE_ENV === 'production') {
    return null
  }
  
  // Return existing instance if already running
  if (serverInstance) {
    return serverInstance
  }
  
  // Try to acquire lock to ensure only one server instance runs system-wide
  if (!acquireLock()) {
    return null
  }
  
  // Default options
  const port = options.port || process.env.CODEPRESS_DEV_PORT || 4321
  
  // Create server
  let server
  try {
    server = http.createServer((req, res) => {
      // Simple request handling
      if (req.url === '/ping') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        res.end('pong')
      } else if (req.url === '/meta') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        // Try to get package version but don't fail if not available
        let version = '0.0.0'
        try {
          // In production builds, use a relative path that works with the installed package structure
          version = require('../package.json').version
        } catch (e) {
          // Ignore error, use default version
        }
        
        res.end(JSON.stringify({
          name: 'Codepress Dev Server',
          version: version,
          environment: process.env.NODE_ENV || 'development',
          uptime: process.uptime()
        }))
      } else {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain')
        res.end('Not found')
      }
    })
    
    // Handle errors to prevent crashes
    server.on('error', (err) => {
      console.error('Codepress Dev Server error:', err)
    })
  } catch (err) {
    console.error('Failed to create server:', err)
    return null
  }
  
  // Start server on available port
  getAvailablePort(port).then(availablePort => {
    server.listen(availablePort, () => {
      console.log(`\x1b[32m✅ Codepress Dev Server running at http://localhost:${availablePort}\x1b[0m`)
    })
  }).catch(err => {
    console.error('Failed to start Codepress Dev Server:', err)
  })
  
  // Save instance
  serverInstance = server
  
  return server
}

// Create module exports
const serverModule = {
  startServer
}

// Start server automatically if in development mode
if (process.env.NODE_ENV !== 'production') {
  serverModule.server = startServer()
}

// Export module
module.exports = serverModule
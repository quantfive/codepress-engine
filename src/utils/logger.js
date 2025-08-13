/**
 * @fileoverview Structured logging utility for CodePress
 * Provides consistent logging with levels and formatting
 */

/**
 * Log levels for structured logging
 */
const LOG_LEVELS = {
  ERROR: "ERROR",
  WARN: "WARN",
  INFO: "INFO",
  DEBUG: "DEBUG",
};

/**
 * ANSI color codes for console output
 */
const COLORS = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};

/**
 * Format a log message with timestamp and level
 * @param {string} level - Log level
 * @param {string} message - Log message
 * @param {Object} [context] - Additional context data
 * @returns {string} Formatted log message
 */
function formatLogMessage(level, message, context = {}) {
  const timestamp = new Date().toISOString();
  const contextStr = Object.keys(context).length > 0 
    ? ` ${JSON.stringify(context)}`
    : "";
  
  return `[${timestamp}] ${level}: ${message}${contextStr}`;
}

/**
 * Log an error message
 * @param {string} message - Error message
 * @param {Object} [context] - Additional context
 */
function logError(message, context = {}) {
  const formatted = formatLogMessage(LOG_LEVELS.ERROR, message, context);
  console.error(`${COLORS.red}✗ ${formatted}${COLORS.reset}`);
}

/**
 * Log a warning message
 * @param {string} message - Warning message
 * @param {Object} [context] - Additional context
 */
function logWarn(message, context = {}) {
  const formatted = formatLogMessage(LOG_LEVELS.WARN, message, context);
  console.warn(`${COLORS.yellow}⚠ ${formatted}${COLORS.reset}`);
}

/**
 * Log an info message
 * @param {string} message - Info message
 * @param {Object} [context] - Additional context
 */
function logInfo(message, context = {}) {
  const formatted = formatLogMessage(LOG_LEVELS.INFO, message, context);
  console.log(`${COLORS.cyan}ℹ ${formatted}${COLORS.reset}`);
}

/**
 * Log a success message
 * @param {string} message - Success message
 * @param {Object} [context] - Additional context
 */
function logSuccess(message, context = {}) {
  const formatted = formatLogMessage(LOG_LEVELS.INFO, message, context);
  console.log(`${COLORS.green}✓ ${formatted}${COLORS.reset}`);
}

/**
 * Log a debug message (only in development)
 * @param {string} message - Debug message
 * @param {Object} [context] - Additional context
 */
function logDebug(message, context = {}) {
  if (process.env.NODE_ENV !== "production") {
    const formatted = formatLogMessage(LOG_LEVELS.DEBUG, message, context);
    console.log(`${COLORS.cyan}🔍 ${formatted}${COLORS.reset}`);
  }
}

/**
 * Log request/response for API calls
 * @param {string} method - HTTP method
 * @param {string} url - Request URL
 * @param {number} status - Response status
 * @param {number} duration - Request duration in ms
 */
function logApiCall(method, url, status, duration) {
  const color = status >= 400 ? COLORS.red : status >= 300 ? COLORS.yellow : COLORS.green;
  const symbol = status >= 400 ? "✗" : status >= 300 ? "⚠" : "✓";
  
  console.log(
    `${color}${symbol} API ${method} ${url} - ${status} (${duration}ms)${COLORS.reset}`
  );
}

/**
 * Create a logger with context
 * @param {string} component - Component name
 * @returns {Object} Logger instance with context
 */
function createLogger(component) {
  return {
    error: (message, context = {}) => logError(message, { component, ...context }),
    warn: (message, context = {}) => logWarn(message, { component, ...context }),
    info: (message, context = {}) => logInfo(message, { component, ...context }),
    success: (message, context = {}) => logSuccess(message, { component, ...context }),
    debug: (message, context = {}) => logDebug(message, { component, ...context }),
    apiCall: (method, url, status, duration) => logApiCall(method, url, status, duration),
  };
}

module.exports = {
  LOG_LEVELS,
  logError,
  logWarn,
  logInfo,
  logSuccess,
  logDebug,
  logApiCall,
  createLogger,
};
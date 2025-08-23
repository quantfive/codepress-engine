/**
 * @fileoverview Structured logging utility for CodePress
 * Provides consistent logging with levels and formatting
 */

import type { LogContext, Logger } from "../types";

/**
 * Log levels for structured logging
 */
export const LOG_LEVELS = {
  ERROR: "ERROR",
  WARN: "WARN", 
  INFO: "INFO",
  DEBUG: "DEBUG",
} as const;

export type LogLevel = typeof LOG_LEVELS[keyof typeof LOG_LEVELS];

/**
 * ANSI color codes for console output
 */
const COLORS = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
} as const;

/**
 * Format a log message with timestamp and level
 */
function formatLogMessage(level: LogLevel, message: string, context: LogContext = {}): string {
  const timestamp: string = new Date().toISOString();
  const contextStr: string = Object.keys(context).length > 0 
    ? ` ${JSON.stringify(context)}`
    : "";
  
  return `[${timestamp}] ${level}: ${message}${contextStr}`;
}

/**
 * Log an error message
 */
export function logError(message: string, context: LogContext = {}): void {
  const formatted: string = formatLogMessage(LOG_LEVELS.ERROR, message, context);
  console.error(`${COLORS.red}✗ ${formatted}${COLORS.reset}`);
}

/**
 * Log a warning message
 */
export function logWarn(message: string, context: LogContext = {}): void {
  const formatted: string = formatLogMessage(LOG_LEVELS.WARN, message, context);
  console.warn(`${COLORS.yellow}⚠ ${formatted}${COLORS.reset}`);
}

/**
 * Log an info message
 */
export function logInfo(message: string, context: LogContext = {}): void {
  const formatted: string = formatLogMessage(LOG_LEVELS.INFO, message, context);
  console.log(`${COLORS.cyan}ℹ ${formatted}${COLORS.reset}`);
}

/**
 * Log a success message
 */
export function logSuccess(message: string, context: LogContext = {}): void {
  const formatted: string = formatLogMessage(LOG_LEVELS.INFO, message, context);
  console.log(`${COLORS.green}✓ ${formatted}${COLORS.reset}`);
}

/**
 * Log a debug message (only in development)
 */
export function logDebug(message: string, context: LogContext = {}): void {
  if (process.env.NODE_ENV !== "production") {
    const formatted: string = formatLogMessage(LOG_LEVELS.DEBUG, message, context);
    console.log(`${COLORS.cyan}🔍 ${formatted}${COLORS.reset}`);
  }
}

/**
 * Log request/response for API calls
 */
export function logApiCall(method: string, url: string, status: number, duration: number): void {
  const color: string = status >= 400 ? COLORS.red : status >= 300 ? COLORS.yellow : COLORS.green;
  const symbol: string = status >= 400 ? "✗" : status >= 300 ? "⚠" : "✓";
  
  console.log(
    `${color}${symbol} API ${method} ${url} - ${status} (${duration}ms)${COLORS.reset}`
  );
}

/**
 * Create a logger with context
 */
export function createLogger(component: string): Logger {
  return {
    error: (message: string, context: LogContext = {}) => 
      logError(message, { component, ...context }),
    warn: (message: string, context: LogContext = {}) => 
      logWarn(message, { component, ...context }),
    info: (message: string, context: LogContext = {}) => 
      logInfo(message, { component, ...context }),
    success: (message: string, context: LogContext = {}) => 
      logSuccess(message, { component, ...context }),
    debug: (message: string, context: LogContext = {}) => 
      logDebug(message, { component, ...context }),
    apiCall: (method: string, url: string, status: number, duration: number) => 
      logApiCall(method, url, status, duration),
  };
}
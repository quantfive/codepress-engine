/**
 * @fileoverview Type definitions for CodePress Engine
 */

// Git-related types
export interface GitInfo {
  branch: string;
  repository: string;
}

// Change-related types
export interface TextChange {
  type: 'insert' | 'delete' | 'replace';
  line?: number;
  startLine?: number;
  endLine?: number;
  codeChange?: string;
  old_text?: string;
  new_text?: string;
  encoded_location?: string;
  style_changes?: StyleChange[];
}

export interface PatternChange {
  type: 'replace' | 'insertAfter' | 'insertBefore' | 'delete';
  find: string;
  replaceWith?: string;
  insert?: string;
  explanation: string;
}

export interface StyleChange {
  property: string;
  value: string;
}

// Request/Response types
export interface VisualEditorRequest {
  changes: ChangeRequest[];
  github_repo_name: string;
}

export interface ChangeRequest {
  encoded_location: string;
  style_changes?: StyleChange[];
  text_changes?: TextChange[];
  browser_width?: number;
  browser_height?: number;
  image_data?: string;
  filename?: string;
}

export interface AgentRequest {
  encoded_location: string;
  github_repo_name: string;
  image_data?: string;
  filename?: string;
  style_changes?: StyleChange[];
  text_changes?: TextChange[];
  additional_context?: string;
  additionalContext?: string;
}

export interface BackendResponse {
  updated_files?: Record<string, string>;
  modified_content?: string;
  coding_agent_output?: Array<{
    path: string;
    changes: (TextChange | PatternChange)[];
  }>;
  changes?: (TextChange | PatternChange)[];
}

// File operations
export interface FileData {
  filePath: string;
  targetFile: string;
  fileContent: string;
}

// Logger types
export interface LogContext {
  [key: string]: any;
}

export interface Logger {
  error: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  success: (message: string, context?: LogContext) => void;
  debug: (message: string, context?: LogContext) => void;
  apiCall: (method: string, url: string, status: number, duration: number) => void;
}

// Server types
export interface ServerOptions {
  port?: number;
}

// Validation types
export interface ValidationResult {
  isValid: boolean;
  error?: string;
  errorData?: Record<string, any>;
}

// Plugin options
export interface PluginOptions {
  secretKey?: string;
  [key: string]: any;
}
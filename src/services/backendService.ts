/**
 * @fileoverview Backend API service for CodePress
 * Handles communication with the CodePress backend API
 */

import fetch from "node-fetch";
import { createLogger } from "../utils/logger";
import type { ChangeRequest, BackendResponse } from "../types";

// Create logger instance for backend service
const logger = createLogger("backendService");

interface GetChangesParams {
  githubRepoName: string;
  fileChanges: Array<{
    encoded_location: string;
    file_content: string;
    changes: Array<{
      style_changes?: any[];
      text_changes?: any[];
    }>;
    browser_width?: number;
    browser_height?: number;
  }>;
  authHeader?: string;
}

interface GetAgentChangesParams {
  githubRepoName: string;
  encodedLocation: string;
  styleChanges?: any[];
  textChanges?: any[];
  fileContent: string;
  additionalContext?: string;
  authHeader?: string;
}

/**
 * Make an HTTP request to the FastAPI backend using fetch
 */
async function callBackendApi(
  method: string, 
  endpoint: string, 
  data: any, 
  incomingAuthHeader?: string
): Promise<any> {
  // Backend API settings
  const apiHost: string = process.env.CODEPRESS_BACKEND_HOST || "localhost";
  const apiPort: number = parseInt(process.env.CODEPRESS_BACKEND_PORT || "8007", 10);
  const apiPath: string = endpoint.startsWith("/")
    ? endpoint.replace("/", "")
    : endpoint;

  // Build the complete URL - detect if using localhost for HTTP, otherwise use HTTPS
  const protocol: string =
    apiHost === "localhost" || apiHost === "127.0.0.1" ? "http" : "https";
  const url: string = `${protocol}://${apiHost}${
    apiPort ? `:${apiPort}` : ""
  }/v1/${apiPath}`;
  
  logger.debug("API request details", {
    method,
    apiPath,
    url,
    hasData: !!data
  });

  try {
    // First try to use API token from environment variable
    let authToken: string | undefined = process.env.CODEPRESS_API_TOKEN;

    logger.debug("Authentication tokens", {
      hasEnvToken: !!authToken,
      hasIncomingAuth: !!incomingAuthHeader
    });

    // If no API token, try to use the incoming Authorization header
    if (!authToken && incomingAuthHeader) {
      authToken = incomingAuthHeader.split(" ")[1]; // Extract token part
      logger.debug("Using incoming Authorization header for authentication");
    }

    // Prepare headers with authentication if token exists
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
      logger.debug("Authentication method", {
        type: process.env.CODEPRESS_API_TOKEN ? "API Token" : "GitHub OAuth Token",
        tokenPreview: `${authToken.substring(0, 10)}...`
      });
    } else {
      logger.warn("No authentication token available");
    }

    const response = await fetch(url, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    // Get the response text
    const responseText: string = await response.text();

    logger.debug("API response received", {
      status: response.status,
      responseLength: responseText.length,
      preview: responseText.substring(0, 100) + (responseText.length > 100 ? "..." : "")
    });

    // Check if response is successful
    if (!response.ok) {
      logger.error("API request failed", {
        status: response.status,
        url,
        method,
        responseText: responseText.substring(0, 500)
      });
      throw new Error(
        `API request failed with status ${response.status}: ${responseText}`
      );
    }

    // Try to parse the response as JSON
    try {
      return JSON.parse(responseText);
    } catch (err) {
      logger.error("Failed to parse JSON response", {
        error: (err as Error).message,
        responsePreview: responseText.substring(0, 200)
      });
      throw new Error(`Invalid JSON response: ${(err as Error).message}`);
    }
  } catch (err) {
    // Handle network errors and other issues
    if ((err as any).name === "FetchError") {
      logger.error("Network error occurred", {
        error: (err as Error).message,
        url,
        method
      });
      throw new Error(`Network error: ${(err as Error).message}`);
    }

    // Re-throw the original error
    throw err;
  }
}

/**
 * Get changes from backend (original endpoint)
 */
export async function getChanges(params: GetChangesParams): Promise<BackendResponse> {
  const { githubRepoName, fileChanges, authHeader } = params;
  
  logger.info("Getting changes from backend", {
    fileCount: fileChanges.length,
    repo: githubRepoName
  });

  return await callBackendApi(
    "POST",
    "code-sync/get-changes",
    {
      github_repo_name: githubRepoName,
      file_changes: fileChanges,
    },
    authHeader
  );
}

/**
 * Get agent changes from backend
 */
export async function getAgentChanges(params: GetAgentChangesParams): Promise<BackendResponse> {
  const {
    githubRepoName,
    encodedLocation,
    fileContent,
    additionalContext,
    authHeader,
  } = params;

  logger.info("Getting agent changes from backend", {
    encodedLocation,
    repo: githubRepoName
  });

  return await callBackendApi(
    "POST",
    "code-sync/get-agent-changes",
    {
      github_repo_name: githubRepoName,
      encoded_location: encodedLocation,
      file_content: fileContent,
      additional_context: additionalContext,
    },
    authHeader
  );
}
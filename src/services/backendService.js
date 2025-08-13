/**
 * @fileoverview Backend API service for CodePress
 * Handles communication with the CodePress backend API
 */

const fetch = require("node-fetch");
const { createLogger } = require("../utils/logger");

// Create logger instance for backend service
const logger = createLogger("backendService");

/**
 * Make an HTTP request to the FastAPI backend using fetch
 * @param {string} method - The HTTP method
 * @param {string} endpoint - The API endpoint
 * @param {Object} data - The request payload
 * @param {string} incomingAuthHeader - The incoming Authorization header
 * @returns {Promise<Object>} The response data
 */
async function callBackendApi(method, endpoint, data, incomingAuthHeader) {
  // Backend API settings
  const apiHost = process.env.CODEPRESS_BACKEND_HOST || "localhost";
  const apiPort = parseInt(process.env.CODEPRESS_BACKEND_PORT || "8007", 10);
  const apiPath = endpoint.startsWith("/")
    ? endpoint.replace("/", "")
    : endpoint;

  // Build the complete URL - detect if using localhost for HTTP, otherwise use HTTPS
  const protocol =
    apiHost === "localhost" || apiHost === "127.0.0.1" ? "http" : "https";
  const url = `${protocol}://${apiHost}${
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
    let authToken = process.env.CODEPRESS_API_TOKEN;

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
    const headers = {
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
    const responseText = await response.text();

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
        error: err.message,
        responsePreview: responseText.substring(0, 200)
      });
      throw new Error(`Invalid JSON response: ${err.message}`);
    }
  } catch (err) {
    // Handle network errors and other issues
    if (err.name === "FetchError") {
      logger.error("Network error occurred", {
        error: err.message,
        url,
        method
      });
      throw new Error(`Network error: ${err.message}`);
    }

    // Re-throw the original error
    throw err;
  }
}

/**
 * Get changes from backend (original endpoint)
 * @param {Object} params - Request parameters
 * @param {string} params.githubRepoName - The GitHub repository name
 * @param {Array<Object>} params.fileChanges - Array of file change objects to process
 * @param {string} [params.authHeader] - The authorization header for backend API authentication
 * @returns {Promise<Object>} Backend response containing the processed changes
 */
async function getChanges({ githubRepoName, fileChanges, authHeader }) {
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
 * @param {Object} params - Request parameters
 * @param {string} params.githubRepoName - Repository name
 * @param {string} params.encodedLocation - Encoded file location
 * @param {string} params.fileContent - File content
 * @param {string} params.additionalContext - Additional context
 * @param {string} [params.authHeader] - Authorization header
 * @returns {Promise<Object>} Backend response
 */
async function getAgentChanges({
  githubRepoName,
  encodedLocation,
  fileContent,
  additionalContext,
  authHeader,
}) {
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

module.exports = {
  callBackendApi,
  getChanges,
  getAgentChanges,
};
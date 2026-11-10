import * as fs from 'fs';

export interface MCPServerMetadata {
  category?: string;
  description?: string;
}

/**
 * How a remote (url) MCP server authenticates.
 *
 * `google-oauth` servers act as the invoking user with that user's own Google
 * OAuth token (Google Workspace MCP). The token is obtained per request from
 * the AgentCore Identity Token Vault, so these servers are never connected at
 * startup or shared between users.
 */
export type MCPServerAuthConfig = {
  type: 'google-oauth';
  // OAuth scopes the server needs. The union over every google-oauth server
  // is what a user consents to when linking Google.
  scopes: string[];
};

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  // See MCPServerAuthConfig
  auth?: MCPServerAuthConfig;
  // Only these tools (MCP names) are given to the model
  allowedTools?: string[];
  // Prefix for the tool names, to avoid collisions between servers
  toolPrefix?: string;
  // Served by the runtime itself instead of an MCP server (e.g.
  // "office-documents"); listed in mcp.json only so agents can select it
  builtin?: string;
  metadata?: MCPServerMetadata;
}

/**
 * Built-in tool sets that ship with the Google Workspace MCP feature. Like
 * the google-oauth servers, they are listed for the frontend only when it is
 * enabled.
 */
export const GOOGLE_WORKSPACE_BUILTINS = ['office-documents'];

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Load MCP configuration from specified file path
 */
export function loadMCPConfig(
  filePath: string
): Record<string, MCPServerConfig> {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(
        `MCP file not found: ${filePath}, using empty configuration`
      );
      return {};
    }

    const mcpConfig: MCPConfig = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return mcpConfig.mcpServers || {};
  } catch (error) {
    console.error(`Error loading MCP configuration from ${filePath}:`, error);
    return {};
  }
}

/**
 * Whether the server needs the user's Google OAuth token
 */
export function requiresGoogleAuth(serverConfig: MCPServerConfig): boolean {
  return serverConfig.auth?.type === 'google-oauth';
}

/**
 * The OAuth scopes a user consents to when linking Google, i.e. the union of
 * the scopes of every google-oauth server in the given configs.
 */
export function collectGoogleOAuthScopes(
  ...mcpServerConfigs: Record<string, MCPServerConfig>[]
): string[] {
  const scopes = new Set<string>();
  for (const mcpServers of mcpServerConfigs) {
    for (const serverConfig of Object.values(mcpServers)) {
      const auth = serverConfig.auth;
      if (auth?.type === 'google-oauth') {
        auth.scopes.forEach((scope) => scopes.add(scope));
      }
    }
  }
  return [...scopes].sort();
}

export interface SafeMCPConfigOptions {
  // List the google-oauth servers and the Google Workspace built-ins. They
  // are left out otherwise, since nothing can give them a token while Google
  // Workspace is disabled.
  googleWorkspaceEnabled?: boolean;
}

/**
 * Extract safe MCP server information for frontend
 * Excludes sensitive information like commands, args, and env variables
 */
export function extractSafeMCPConfig(
  mcpServers: Record<string, MCPServerConfig>,
  options: SafeMCPConfigOptions = {}
): string {
  const safeConfig: Record<
    string,
    { metadata?: MCPServerMetadata; requiresGoogleAuth?: boolean }
  > = {};

  Object.keys(mcpServers).forEach((serverName) => {
    const serverConfig = mcpServers[serverName];
    if (requiresGoogleAuth(serverConfig)) {
      if (!options.googleWorkspaceEnabled) {
        return;
      }
      safeConfig[serverName] = {
        metadata: serverConfig.metadata,
        requiresGoogleAuth: true,
      };
      return;
    }
    if (
      serverConfig.builtin &&
      GOOGLE_WORKSPACE_BUILTINS.includes(serverConfig.builtin) &&
      !options.googleWorkspaceEnabled
    ) {
      return;
    }
    safeConfig[serverName] = {
      metadata: serverConfig.metadata,
    };
  });

  return JSON.stringify(safeConfig);
}

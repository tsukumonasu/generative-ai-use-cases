export interface AvailableMCPServer {
  name: string;
  description: string;
  category: string;
  // The server acts as the signed-in user with their own Google OAuth token
  // (Google Workspace MCP), so the user must link Google first
  requiresGoogleAuth?: boolean;
}

export type AvailableMCPServers = AvailableMCPServer[];

"""Tool management for the agent core runtime."""

import json
import logging
import os
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any

import boto3
import httpx
from mcp import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import ElicitResult
from strands import tool
from strands.tools.mcp import MCPClient

from .config import WORKSPACE_DIR, get_aws_credentials, get_uv_environment
from .documents import DOCUMENT_TOOLS_PROMPT, GOOGLE_FILE_TOOLS_PROMPT, OFFICE_DOCUMENTS, build_document_tools, build_google_file_tools, convert_to_pdf_via_drive

# Import strands-agents code interpreter tool
try:
    from strands_tools.code_interpreter import AgentCoreCodeInterpreter

    CODE_INTERPRETER_AVAILABLE = True
except ImportError as e:
    CODE_INTERPRETER_AVAILABLE = False
    logger = logging.getLogger(__name__)
    logger.warning(f"Strands code interpreter tool not available: {e}")
    AgentCoreCodeInterpreter = None

logger = logging.getLogger(__name__)

# Google Workspace MCP servers act as the invoking user with that
# user's own Google OAuth token, which the frontend gets from the GenU API
# (Cognito-authorized) and sends with each request. These servers are
# connected per request and never shared or cached, so one user's token is
# never used for another user's request.
GOOGLE_OAUTH_AUTH_TYPE = "google-oauth"


# Google scope that lets the runtime create files in the user's Drive
# (save_to_google_drive)
GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"


def requires_user_token(server_config: dict) -> bool:
    """Whether the server needs the invoking user's Google OAuth token"""
    auth = server_config.get("auth")
    return isinstance(auth, dict) and auth.get("type") == GOOGLE_OAUTH_AUTH_TYPE


def is_builtin(server_config: dict) -> bool:
    """An entry served by this process ({"builtin": "<name>"}), listed in
    mcp.json only so that agents can select it"""
    return isinstance(server_config.get("builtin"), str)


def is_stdio(server_config: dict) -> bool:
    """Servers started as subprocesses and shared between requests"""
    return not requires_user_token(server_config) and not is_builtin(server_config)


async def _decline_elicitation(context, params) -> ElicitResult:
    """Google asks for confirmation before sensitive tool calls. Nothing can show
    the request to the user here, so never confirm on their behalf."""
    logger.warning("Declined an MCP elicitation request: no UI to confirm it with the user")
    return ElicitResult(action="decline")


def _create_user_token_mcp_client(server_config: dict, access_token: str) -> MCPClient:
    """MCP client for a remote Streamable HTTP server called with the user's
    token. Only the server's allowedTools (mcp.json) are given to the model."""
    url = server_config["url"]
    headers = {"Authorization": f"Bearer {access_token}"}

    @asynccontextmanager
    async def transport():
        async with httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(30, read=300)) as http_client:
            async with streamable_http_client(url, http_client=http_client) as streams:
                yield streams

    allowed_tools = server_config.get("allowedTools")
    return MCPClient(
        transport,
        # Matched against the server's own tool names (before the prefix).
        # An empty list means "no tools", never "no filter".
        tool_filters={"allowed": allowed_tools} if allowed_tools is not None else None,
        prefix=server_config.get("toolPrefix"),
        elicitation_callback=_decline_elicitation,
    )


def _read_mcp_servers() -> dict[str, Any] | None:
    """mcpServers of the config at MCP_CONFIG_PATH, or None when there is none"""
    mcp_config_path = os.environ.get("MCP_CONFIG_PATH")
    if not mcp_config_path or not os.path.exists(mcp_config_path):
        return None
    logger.info(f"Loading MCP configuration from {mcp_config_path}")
    with open(mcp_config_path) as f:
        return json.load(f).get("mcpServers", {})


def _create_mcp_client(server_name: str, server_config: dict, uv_env: dict) -> tuple[str, MCPClient | None]:
    """Create and start an MCP client (for parallel execution)"""
    try:
        client = MCPClient(
            lambda: stdio_client(
                StdioServerParameters(
                    command=server_config["command"],
                    args=server_config.get("args", []),
                    env={**uv_env, **server_config.get("env", {})},
                )
            )
        )
        client.start()
        return server_name, client
    except Exception as e:
        logger.error(f"Error creating MCP client for {server_name}: {e}")
        return server_name, None


class ToolManager:
    """Manages tools including MCP tools and built-in tools."""

    def __init__(self):
        self.mcp_tools = None
        self.session_id = None
        self.trace_id = None

    def set_session_info(self, session_id: str, trace_id: str):
        """Set session and trace IDs for tool operations"""
        self.session_id = session_id
        self.trace_id = trace_id

    def load_mcp_tools(self) -> list[Any]:
        """Load MCP tools from environment variable or mcp.json file"""
        if self.mcp_tools is not None:
            return self.mcp_tools

        try:
            # Log UV environment configuration
            uv_env = get_uv_environment()

            # Load from MCP_CONFIG_PATH
            mcp_servers = _read_mcp_servers()
            if mcp_servers is None:
                return []
            # These tools are cached and shared by every request, so servers
            # that act as the invoking user can never be among them
            mcp_servers = {name: config for name, config in mcp_servers.items() if is_stdio(config)}

            mcp_clients = []

            with ThreadPoolExecutor() as executor:
                futures = [executor.submit(_create_mcp_client, name, config, uv_env) for name, config in mcp_servers.items()]
                for future in futures:
                    name, client = future.result()
                    if client:
                        mcp_clients.append(client)

            # Flatten the tools
            self.mcp_tools = sum([c.list_tools_sync() for c in mcp_clients], [])
            logger.info(f"Loaded {len(self.mcp_tools)} MCP tools")
            return self.mcp_tools

        except Exception as e:
            logger.error(f"Error loading MCP tools: {e}")
            self.mcp_tools = []
            return self.mcp_tools

    def load_mcp_tools_by_names(self, server_names: list[str]) -> list[Any]:
        """Load MCP tools from environment variable or mcp.json by server names"""
        if not server_names:
            return []

        try:
            # Log UV environment configuration
            uv_env = get_uv_environment()

            # Load from MCP_CONFIG_PATH
            available_servers = _read_mcp_servers()
            if available_servers is None:
                return []

            logger.info(f"Found {len(available_servers)} available MCP servers")
            mcp_clients = []

            # Servers that act as the invoking user are loaded by load_user_token_mcp_tools,
            # built-in ones by load_builtin_tools
            servers_to_load = {name: available_servers[name] for name in server_names if name in available_servers and is_stdio(available_servers[name])}

            with ThreadPoolExecutor() as executor:
                futures = [executor.submit(_create_mcp_client, name, config, uv_env) for name, config in servers_to_load.items()]
                for future in futures:
                    name, client = future.result()
                    if client:
                        mcp_clients.append(client)
                        logger.info(f"Successfully loaded MCP server: {name}")

            # Flatten the tools
            dynamic_tools = sum([c.list_tools_sync() for c in mcp_clients], [])
            logger.info(f"Loaded {len(dynamic_tools)} MCP tools from {len(mcp_clients)} servers")
            return dynamic_tools

        except Exception as e:
            logger.error(f"Error loading MCP tools by names: {e}")
            return []

    def load_user_token_mcp_tools(self, server_names: list[str] | None, google_access_token: str | None) -> tuple[list[Any], list[MCPClient], list[str]]:
        """Connect the requested servers that act as the invoking user.

        Returns the tools, the clients (the caller must stop them once the
        request is over, so the token does not outlive it) and the names of
        the requested servers that could not be used.
        """
        if not server_names:
            return [], [], []

        available_servers = _read_mcp_servers() or {}
        targets = {name: available_servers[name] for name in server_names if name in available_servers and requires_user_token(available_servers[name])}
        if not targets:
            return [], [], []

        if not google_access_token:
            logger.warning(f"No Google access token in the request; skipping MCP servers: {list(targets)}")
            return [], [], list(targets)

        def connect(name: str, config: dict) -> tuple[MCPClient | None, list[Any]]:
            client = None
            try:
                client = _create_user_token_mcp_client(config, google_access_token)
                client.start()
                server_tools = client.list_tools_sync()
                logger.info(f"Loaded {len(server_tools)} tools from MCP server {name}")
                return client, server_tools
            except Exception as e:
                # The exception names the URL and status only, never the token
                logger.error(f"Error connecting to MCP server {name}: {e}")
                if client is not None:
                    stop_mcp_clients([client])
                return None, []

        tools: list[Any] = []
        clients: list[MCPClient] = []
        unavailable: list[str] = []
        # Connected in parallel: an agent may use every Google product, and
        # connecting them one after another would add seconds to each message
        with ThreadPoolExecutor(max_workers=len(targets)) as executor:
            results = executor.map(lambda item: (item[0], *connect(*item)), targets.items())
            for name, client, server_tools in results:
                if client is None:
                    unavailable.append(name)
                else:
                    clients.append(client)
                    tools.extend(server_tools)
        return tools, clients, unavailable

    def load_builtin_tools(self, server_names: list[str] | None, google_access_token: str | None) -> tuple[list[Any], str, list[Callable[[], None]]]:
        """Tools of the requested built-in servers, the system prompt section
        that explains them, and the cleanups the caller must run once the
        request is over (for built-ins that hold the user's tokens).

        The Google Drive file tools (saving, exporting, PDFs, previews) come
        with office-documents when the request also uses a Google server that
        grants drive.file and carries a token.
        """
        available_servers = _read_mcp_servers() or {}
        # None means every configured server, as in get_tools_with_options
        names = list(available_servers) if server_names is None else [n for n in server_names if n in available_servers]
        builtins = {available_servers[n]["builtin"] for n in names if is_builtin(available_servers[n])}
        tools: list[Any] = []
        prompt = ""
        cleanups: list[Callable[[], None]] = []

        if OFFICE_DOCUMENTS in builtins:
            drive_granted = any(requires_user_token(available_servers[n]) and GOOGLE_DRIVE_FILE_SCOPE in available_servers[n]["auth"].get("scopes", []) for n in names)
            if drive_granted and google_access_token:
                # PDFs are made through the user's Drive (no LibreOffice in the image)
                tools += build_document_tools(self.trace_id, lambda path: convert_to_pdf_via_drive(google_access_token, path))
                tools += build_google_file_tools(self.trace_id, google_access_token)
                prompt += DOCUMENT_TOOLS_PROMPT + GOOGLE_FILE_TOOLS_PROMPT
            else:
                tools += build_document_tools(self.trace_id)
                prompt += DOCUMENT_TOOLS_PROMPT
            logger.info("Loaded the built-in document tools")

        return tools, prompt, cleanups

    def get_upload_tool(self):
        """Get the S3 upload tool with session context"""
        trace_id = self.trace_id

        @tool
        def upload_file_to_s3_and_retrieve_s3_url(filepath: str) -> str:
            """Upload the file at /tmp/ws/* and retrieve the s3 path

            Args:
                filepath: The path to the uploading file
            """
            bucket = os.environ.get("FILE_BUCKET")
            if not bucket:
                # For local testing, provide a fallback message
                logger.warning("FILE_BUCKET environment variable not set. Using local file path for testing.")
                return f"Local file path (S3 upload skipped): {filepath}"

            aws_creds = get_aws_credentials()
            region = aws_creds.get("AWS_REGION", "us-east-1")

            if not filepath.startswith(WORKSPACE_DIR):
                raise ValueError(f"{filepath} does not appear to be a file under the {WORKSPACE_DIR} directory. Files to be uploaded must exist under {WORKSPACE_DIR}.")

            try:
                filename = os.path.basename(filepath)
                key = f"agentcore/{trace_id}/{filename}"

                s3 = boto3.client("s3", region_name=region)
                s3.upload_file(filepath, bucket, key)

                return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"
            except Exception as e:
                logger.error(f"Error uploading file to S3: {e}")
                # For local testing, provide a fallback
                return f"Error uploading to S3: {str(e)}. Local file path: {filepath}"

        return upload_file_to_s3_and_retrieve_s3_url

    def get_code_interpreter_tool(self) -> list[Any]:
        """Get code interpreter tool if available"""
        code_interpreter_tools = []

        if CODE_INTERPRETER_AVAILABLE and AgentCoreCodeInterpreter:
            try:
                aws_creds = get_aws_credentials()
                region = aws_creds.get("AWS_REGION", "us-east-1")
                code_interpreter = AgentCoreCodeInterpreter(region=region)
                code_interpreter_tools.append(code_interpreter.code_interpreter)
                logger.info("Added code_interpreter tool (AgentCoreCodeInterpreter)")
            except Exception as e:
                logger.warning(f"Failed to initialize AgentCoreCodeInterpreter: {e}")

        return code_interpreter_tools

    def get_tools_with_options(self, code_execution_enabled: bool = False, mcp_servers=None) -> list[Any]:
        """
        Get tools with optional code execution and MCP servers.

        Args:
            code_execution_enabled: Whether to include code interpreter tools
            mcp_servers: MCP server configurations
                - None: Load default MCP servers from mcp.json
                - []: Empty list, no MCP servers (File Upload only)
                - [...]: Load specified MCP servers

        Returns:
            List of all available tools
        """
        logger.info(f"get_tools_with_options called with code_execution_enabled={code_execution_enabled}")
        logger.info(f"mcp_servers parameter: {mcp_servers} (type: {type(mcp_servers)})")

        all_tools = []

        # Handle MCP servers based on parameter
        if mcp_servers is None:
            # Load default MCP servers from mcp.json
            logger.info("Loading default MCP servers from mcp.json")
            mcp_tools = self.load_mcp_tools()
        elif isinstance(mcp_servers, list) and len(mcp_servers) == 0:
            # Empty list: no MCP servers
            logger.info("Empty MCP servers list provided, skipping MCP tools")
            mcp_tools = []
        elif isinstance(mcp_servers, list):
            # Load specified MCP servers by name
            logger.info(f"Loading {len(mcp_servers)} user-specified MCP servers by name")
            mcp_tools = self.load_mcp_tools_by_names(mcp_servers)
        else:
            # Fallback to default
            logger.warning(f"Unexpected mcp_servers type: {type(mcp_servers)}, using default")
            mcp_tools = self.load_mcp_tools()

        all_tools.extend(mcp_tools)

        # Add built-in tools (always included)
        upload_tool = self.get_upload_tool()
        all_tools.append(upload_tool)

        # Add code interpreter tools if enabled
        code_interpreter_tools = []
        if code_execution_enabled:
            code_interpreter_tools = self.get_code_interpreter_tool()
            all_tools.extend(code_interpreter_tools)

        # Log final tool count
        logger.info(f"Total tools loaded: {len(all_tools)} (MCP: {len(mcp_tools)}, Built-in: 1, Code Interpreter: {len(code_interpreter_tools)} - {'enabled' if code_execution_enabled else 'disabled'})")

        return all_tools


def stop_mcp_clients(clients: list[MCPClient]) -> None:
    """Close per-request MCP clients (and with them the user's token)"""
    for client in clients:
        try:
            client.stop(None, None, None)
        except Exception as e:
            logger.warning(f"Error stopping MCP client: {e}")

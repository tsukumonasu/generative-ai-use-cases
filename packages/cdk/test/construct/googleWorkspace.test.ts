import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  CognitoUserPoolsAuthorizer,
  MockIntegration,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BUNDLING_STACKS } from 'aws-cdk-lib/cx-api';
import {
  GOOGLE_API_SCOPES,
  GoogleWorkspace,
} from '../../lib/construct/google-workspace';
import { LAMBDA_RUNTIME_NODEJS } from '../../consts';
import { stackInputSchema } from '../../lib/stack-input';
import {
  collectGoogleOAuthScopes,
  extractSafeMCPConfig,
  loadMCPConfig,
  MCPServerConfig,
} from '../../lib/utils/mcp-config-loader';

const synth = () => {
  const app = new App({ context: { [BUNDLING_STACKS]: [] } });
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  const api = new RestApi(stack, 'Api', {
    defaultIntegration: new MockIntegration(),
  });
  api.root.addMethod('GET');
  const authorizer = new CognitoUserPoolsAuthorizer(stack, 'Authorizer', {
    cognitoUserPools: [new UserPool(stack, 'UserPool')],
  });
  const apiHandler = new NodejsFunction(stack, 'ApiHandler', {
    runtime: LAMBDA_RUNTIME_NODEJS,
    entry: path.join(__dirname, '../../lambda/api/index.ts'),
  });
  new GoogleWorkspace(stack, 'GoogleWorkspace', {
    env: 'dev',
    api,
    authorizer,
    apiHandler,
    credentialProviderName: 'genu-google-workspace',
    allowedUsers: ['alice@example.co.jp', 'bob@example.co.jp'],
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    webOrigins: [
      'https://d111111abcdef8.cloudfront.net',
      'https://ai.example.net',
    ],
  });
  return Template.fromStack(stack);
};

describe('GoogleWorkspace construct', () => {
  const template = synth();

  test('allows consent to return to every web origin', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::WorkloadIdentity', {
      Name: 'GenUGoogleWorkspacedev',
      AllowedResourceOauth2ReturnUrls: [
        'https://d111111abcdef8.cloudfront.net/google-workspace/callback',
        'https://ai.example.net/google-workspace/callback',
      ],
    });
  });

  test('scopes the token permissions to its own workload identity and provider', () => {
    const statements = Object.values(
      template.findResources('AWS::IAM::Policy')
    ).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const statementFor = (action: string) =>
      statements.find((s) => [s.Action].flat().includes(action));

    const forUserId = statementFor(
      'bedrock-agentcore:GetWorkloadAccessTokenForUserId'
    );
    expect(JSON.stringify(forUserId.Resource)).toContain(
      'workload-identity-directory/default'
    );
    expect(JSON.stringify(forUserId.Resource)).not.toContain('*');

    const token = statementFor('bedrock-agentcore:GetResourceOauth2Token');
    expect([token.Action].flat()).toContain(
      'bedrock-agentcore:CompleteResourceTokenAuth'
    );
    expect(JSON.stringify(token.Resource)).toContain(
      'token-vault/default/oauth2credentialprovider/genu-google-workspace'
    );

    const secret = statementFor('secretsmanager:GetSecretValue');
    expect(JSON.stringify(secret.Resource)).toContain(
      'secret:bedrock-agentcore-identity!default/oauth2/genu-google-workspace-*'
    );
  });

  test('gives the monolith what it needs to serve tokens', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GOOGLE_WORKSPACE_WORKLOAD_NAME: Match.anyValue(),
          GOOGLE_WORKSPACE_CREDENTIAL_PROVIDER_NAME: 'genu-google-workspace',
          GOOGLE_WORKSPACE_SCOPES:
            'https://www.googleapis.com/auth/drive.readonly',
          GOOGLE_WORKSPACE_ALLOWED_USERS:
            'alice@example.co.jp,bob@example.co.jp',
          GOOGLE_WORKSPACE_RETURN_ORIGINS:
            'https://d111111abcdef8.cloudfront.net,https://ai.example.net',
        }),
      },
    });
  });

  test('puts every route behind the Cognito authorizer', () => {
    for (const pathPart of ['status', 'authorize', 'complete', 'token']) {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: pathPart,
      });
    }
    const methods = Object.values(
      template.findResources('AWS::ApiGateway::Method')
    ).filter((m) => m.Properties.HttpMethod !== 'OPTIONS');
    const routeMethods = methods.filter(
      (m) => m.Properties.AuthorizationType !== 'NONE'
    );
    // The 4 routes; the root GET of the test API is the only other method
    expect(routeMethods).toHaveLength(4);
    routeMethods.forEach((m) =>
      expect(m.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS')
    );
  });
});

describe('Google Workspace parameters', () => {
  test('need the credential provider name when enabled', () => {
    expect(() =>
      stackInputSchema.parse({ googleWorkspaceMcpEnabled: true })
    ).toThrow(/googleWorkspaceCredentialProviderName/);
    expect(() =>
      stackInputSchema.parse({
        googleWorkspaceMcpEnabled: true,
        googleWorkspaceCredentialProviderName: 'genu-google-workspace',
      })
    ).not.toThrow();
  });

  test('are off by default', () => {
    const params = stackInputSchema.parse({});
    expect(params.googleWorkspaceMcpEnabled).toBe(false);
    expect(params.googleWorkspaceAllowedUsers).toEqual([]);
  });
});

describe('MCP config for Google Workspace', () => {
  const servers: Record<string, MCPServerConfig> = {
    time: { command: 'uvx', args: ['mcp-server-time'] },
    'google-drive': {
      url: 'https://drivemcp.googleapis.com/mcp/v1',
      auth: {
        type: 'google-oauth',
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      },
      metadata: { category: 'Google Workspace', description: 'Drive' },
    },
    'google-gmail': {
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      auth: {
        type: 'google-oauth',
        scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/drive.readonly',
        ],
      },
    },
  };

  test('consent covers the union of the Google servers scopes', () => {
    expect(collectGoogleOAuthScopes(servers, {})).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ]);
  });

  test('lists Google servers for the frontend only when enabled', () => {
    expect(Object.keys(JSON.parse(extractSafeMCPConfig(servers)))).toEqual([
      'time',
    ]);
    const enabled = JSON.parse(
      extractSafeMCPConfig(servers, { googleWorkspaceEnabled: true })
    );
    expect(enabled['google-drive']).toEqual({
      metadata: { category: 'Google Workspace', description: 'Drive' },
      requiresGoogleAuth: true,
    });
    expect(enabled.time).toEqual({});
  });

  test('lists the Google Workspace built-ins only when enabled', () => {
    const withBuiltin: Record<string, MCPServerConfig> = {
      ...servers,
      'office-documents': { builtin: 'office-documents' },
    };
    expect(Object.keys(JSON.parse(extractSafeMCPConfig(withBuiltin)))).toEqual([
      'time',
    ]);
    expect(
      Object.keys(
        JSON.parse(
          extractSafeMCPConfig(withBuiltin, { googleWorkspaceEnabled: true })
        )
      )
    ).toContain('office-documents');
  });

  describe('the shipped Agent Builder config', () => {
    const shipped = loadMCPConfig(
      path.join(
        __dirname,
        '../../lambda-python/generic-agent-core-runtime/mcp-configs/agent-builder/mcp.json'
      )
    );
    const googleServers = Object.entries(shipped).filter(
      ([, config]) => config.auth?.type === 'google-oauth'
    );

    test('asks Google for read-only scopes plus the reviewed write scopes only', () => {
      // Read-only scopes whose names do not end in .readonly
      const readOnlyWithoutSuffix = [
        // Free/busy only (Calendar suggest_time)
        'https://www.googleapis.com/auth/calendar.events.freebusy',
        // The user's own basic profile (People get_user_profile)
        'https://www.googleapis.com/auth/userinfo.profile',
      ];
      // Write scopes the assistant may use (drafts, adding events, new Drive
      // files, editing Docs/Sheets/Slides). Which tools use them is limited
      // by allowedTools (see below).
      const reviewedWriteScopes = [
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/presentations',
      ];
      const scopes = collectGoogleOAuthScopes(shipped);
      expect(scopes.length).toBeGreaterThan(0);
      scopes
        .filter(
          (scope) =>
            !readOnlyWithoutSuffix.includes(scope) &&
            !reviewedWriteScopes.includes(scope)
        )
        .forEach((scope) => expect(scope).toMatch(/\.readonly$/));
    });

    test('limits every Google server to an explicit list of tools', () => {
      // Without the list, a server's other write tools (send_message,
      // delete_event, ...) would be given to the model as well
      expect(googleServers.length).toBeGreaterThan(0);
      googleServers.forEach(([, config]) =>
        expect(config.allowedTools?.length).toBeGreaterThan(0)
      );
    });

    test('never allows sending, deleting, sharing or changing events', () => {
      const forbidden = [
        // Chat
        'send_message',
        'mark_as_read',
        'mark_as_unread',
        'update_notification_settings',
        // Calendar: only create_event may write
        'update_event',
        'delete_event',
        'respond_to_event',
        // Gmail: only create_draft may write
        'label_message',
        'label_thread',
        'unlabel_message',
        'unlabel_thread',
        // Drive: only create_file may write
        'copy_file',
      ];
      googleServers.forEach(([, config]) =>
        config.allowedTools?.forEach((tool) =>
          expect(forbidden).not.toContain(tool)
        )
      );
    });

    test('the API itself adds no scope of its own', () => {
      expect(GOOGLE_API_SCOPES).toEqual([]);
    });

    test('adds nothing to the frontend list while disabled', () => {
      const listed = Object.keys(JSON.parse(extractSafeMCPConfig(shipped)));
      expect(listed.filter((name) => name.startsWith('google-'))).toEqual([]);
      expect(listed).not.toContain('office-documents');
    });

    test('lists the office-documents built-in server', () => {
      expect(shipped['office-documents']?.builtin).toBe('office-documents');
    });
  });
});

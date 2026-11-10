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
import { Backlog } from '../../lib/construct/backlog';
import { LAMBDA_RUNTIME_NODEJS } from '../../consts';
import { stackInputSchema } from '../../lib/stack-input';

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
  new Backlog(stack, 'Backlog', {
    env: 'dev',
    api,
    authorizer,
    apiHandler,
    credentialProviderName: 'genu-backlog',
    spaceDomain: 'example.backlog.jp',
    allowedUsers: ['*'],
    inProgressOnCreateProjects: ['PROJ', 'OPS'],
    webOrigins: [
      'https://d111111abcdef8.cloudfront.net',
      'https://ai.example.net',
    ],
  });
  return Template.fromStack(stack);
};

describe('Backlog construct', () => {
  const template = synth();

  test('has a workload identity of its own that returns to every web origin', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::WorkloadIdentity', {
      Name: 'GenUBacklogdev',
      AllowedResourceOauth2ReturnUrls: [
        'https://d111111abcdef8.cloudfront.net/backlog/callback',
        'https://ai.example.net/backlog/callback',
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
    expect(JSON.stringify(forUserId.Resource)).not.toContain('*');

    const token = statementFor('bedrock-agentcore:GetResourceOauth2Token');
    expect(JSON.stringify(token.Resource)).toContain(
      'token-vault/default/oauth2credentialprovider/genu-backlog'
    );

    const secret = statementFor('secretsmanager:GetSecretValue');
    expect(JSON.stringify(secret.Resource)).toContain(
      'secret:bedrock-agentcore-identity!default/oauth2/genu-backlog-*'
    );
  });

  test('gives the monolith what it needs to serve tokens', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          BACKLOG_WORKLOAD_NAME: Match.anyValue(),
          BACKLOG_CREDENTIAL_PROVIDER_NAME: 'genu-backlog',
          BACKLOG_SPACE_DOMAIN: 'example.backlog.jp',
          BACKLOG_ALLOWED_USERS: '*',
          BACKLOG_RETURN_ORIGINS:
            'https://d111111abcdef8.cloudfront.net,https://ai.example.net',
          BACKLOG_IN_PROGRESS_ON_CREATE_PROJECTS: 'PROJ,OPS',
        }),
      },
    });
  });

  test('puts every route behind the Cognito authorizer', () => {
    for (const pathPart of [
      'backlog',
      'status',
      'authorize',
      'complete',
      'tasks',
      'my-issues',
      'activities',
      'members',
      'gantt',
      'projects',
      '{projectKey}',
      'issues',
      '{issueKey}',
      'comments',
      'documents',
    ]) {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: pathPart,
      });
    }
    const routeMethods = Object.values(
      template.findResources('AWS::ApiGateway::Method')
    ).filter(
      (m) =>
        m.Properties.HttpMethod !== 'OPTIONS' &&
        m.Properties.AuthorizationType !== 'NONE'
    );
    // status, authorize, complete, tasks, my-issues, activities,
    // members, gantt, projects, projects/{projectKey}, issues (GET, POST),
    // issues/{issueKey}, issues/{issueKey}/comments,
    // projects/{projectKey}/documents, documents
    expect(routeMethods).toHaveLength(16);
    routeMethods.forEach((m) =>
      expect(m.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS')
    );
  });
});

describe('Backlog parameters', () => {
  test('are off by default', () => {
    const params = stackInputSchema.parse({});
    expect(params.backlogEnabled).toBe(false);
    expect(params.backlogAllowedUsers).toEqual([]);
    expect(params.backlogInProgressOnCreateProjects).toEqual([]);
  });

  test('need the provider name and a Backlog space when enabled', () => {
    expect(() =>
      stackInputSchema.parse({
        backlogEnabled: true,
        backlogSpaceDomain: 'example.backlog.jp',
      })
    ).toThrow(/backlogCredentialProviderName/);
    for (const backlogSpaceDomain of [
      '',
      'https://example.backlog.jp',
      'example.backlog.jp.evil.com',
      'evil.example.com',
    ]) {
      expect(() =>
        stackInputSchema.parse({
          backlogEnabled: true,
          backlogCredentialProviderName: 'genu-backlog',
          backlogSpaceDomain,
        })
      ).toThrow(/backlogSpaceDomain/);
    }
    expect(() =>
      stackInputSchema.parse({
        backlogEnabled: true,
        backlogCredentialProviderName: 'genu-backlog',
        backlogSpaceDomain: 'example.backlog.jp',
      })
    ).not.toThrow();
  });
});

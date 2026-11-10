import { Construct } from 'constructs';
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  MethodOptions,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { WorkloadIdentity } from 'aws-cdk-lib/aws-bedrockagentcore';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
// The page AgentCore Identity sends the browser back to after Google consent
// (pages/GoogleWorkspaceCallbackPage.tsx). It completes the session binding.
import { GOOGLE_WORKSPACE_CALLBACK_PATH } from '../../lambda/googleWorkspace';
import { grantUserTokenVaultAccess } from '../utils/token-vault-access';

/**
 * Scopes the GenU API itself uses with the user's Google token, on top of the
 * MCP servers' scopes (none yet). Adding a scope here makes every user link
 * Google again.
 */
export const GOOGLE_API_SCOPES: string[] = [];

export interface GoogleWorkspaceProps {
  readonly env: string;
  readonly api: RestApi;
  readonly authorizer: CognitoUserPoolsAuthorizer;
  // Monolith API Lambda (lambda/api/index.ts). The /google-workspace handlers
  // run in it (lambda/api/routes/googleWorkspace.ts).
  readonly apiHandler: NodejsFunction;
  // AgentCore Identity OAuth2 credential provider (GoogleOauth2 vendor),
  // created by hand so that the client secret stays out of the template
  readonly credentialProviderName: string;
  // Users (cognito:username or email) who may link Google
  readonly allowedUsers: string[];
  // OAuth scopes requested at consent (union over the google-oauth MCP
  // servers, plus GOOGLE_API_SCOPES)
  readonly scopes: string[];
  // Every origin users open GenU from. The Cognito session lives in the
  // browser per origin, so consent has to return to the origin it started on.
  readonly webOrigins: string[];
}

/**
 * Lets each user link their own Google account for the Google
 * Workspace MCP servers.
 *
 * Tokens are kept in the AgentCore Identity Token Vault under a workload
 * identity owned by this construct (not the one AgentCore Runtime creates for
 * itself, which cannot hand out tokens to its caller). Only the monolith API
 * Lambda can read them, keyed by the Cognito user that the API Gateway
 * authorizer verified, so one user's token is never served to another.
 */
export class GoogleWorkspace extends Construct {
  public readonly workloadIdentityName: string;

  constructor(scope: Construct, id: string, props: GoogleWorkspaceProps) {
    super(scope, id);

    const { apiHandler, credentialProviderName } = props;

    const workloadIdentity = new WorkloadIdentity(this, 'WorkloadIdentity', {
      workloadIdentityName: `GenUGoogleWorkspace${props.env}`,
      allowedResourceOauth2ReturnUrls: props.webOrigins.map(
        (origin) => `${origin}${GOOGLE_WORKSPACE_CALLBACK_PATH}`
      ),
    });
    this.workloadIdentityName = workloadIdentity.workloadIdentityName;

    grantUserTokenVaultAccess(
      this,
      apiHandler,
      workloadIdentity.workloadIdentityArn,
      credentialProviderName
    );

    apiHandler.addEnvironment(
      'GOOGLE_WORKSPACE_WORKLOAD_NAME',
      workloadIdentity.workloadIdentityName
    );
    apiHandler.addEnvironment(
      'GOOGLE_WORKSPACE_CREDENTIAL_PROVIDER_NAME',
      credentialProviderName
    );
    apiHandler.addEnvironment(
      'GOOGLE_WORKSPACE_SCOPES',
      props.scopes.join(' ')
    );
    apiHandler.addEnvironment(
      'GOOGLE_WORKSPACE_ALLOWED_USERS',
      props.allowedUsers.join(',')
    );
    apiHandler.addEnvironment(
      'GOOGLE_WORKSPACE_RETURN_ORIGINS',
      props.webOrigins.join(',')
    );

    // API Gateway routes. Methods without an integration inherit the RestApi
    // defaultIntegration (the monolith proxy), as in the Template construct.
    const authorized: MethodOptions = {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: props.authorizer,
    };
    const root = props.api.root.addResource('google-workspace');
    root.addResource('status').addMethod('GET', undefined, authorized);
    root.addResource('authorize').addMethod('POST', undefined, authorized);
    root.addResource('complete').addMethod('POST', undefined, authorized);
    root.addResource('token').addMethod('POST', undefined, authorized);
  }
}

import { Construct } from 'constructs';
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  MethodOptions,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { WorkloadIdentity } from 'aws-cdk-lib/aws-bedrockagentcore';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
// The page AgentCore Identity sends the browser back to after Backlog consent
// (pages/BacklogCallbackPage.tsx). It completes the session binding.
import { BACKLOG_CALLBACK_PATH } from '../../lambda/backlog';
import { grantUserTokenVaultAccess } from '../utils/token-vault-access';

export interface BacklogProps {
  readonly env: string;
  readonly api: RestApi;
  readonly authorizer: CognitoUserPoolsAuthorizer;
  // Monolith API Lambda (lambda/api/index.ts). The /backlog handlers run in it
  // (lambda/api/routes/backlog.ts).
  readonly apiHandler: NodejsFunction;
  // AgentCore Identity OAuth2 credential provider (CustomOauth2 vendor),
  // created by hand so that the client secret stays out of the template
  readonly credentialProviderName: string;
  // The Backlog space, e.g. "example.backlog.jp"
  readonly spaceDomain: string;
  // Users (cognito:username, not email) who may link Backlog. ["*"] allows
  // every signed-in user; no one may while it is empty.
  readonly allowedUsers: string[];
  // Projects (keys) whose new issues are set to In Progress right after
  // they are created from GenU
  readonly inProgressOnCreateProjects: string[];
  // Every origin users open GenU from. The Cognito session lives in the
  // browser per origin, so consent has to return to the origin it started on.
  readonly webOrigins: string[];
}

/**
 * Lets each user link their own Backlog account, for the Backlog page.
 *
 * The tokens live in the AgentCore Identity Token Vault under a workload
 * identity of this construct, so the integration is independent of any
 * other per-user integration. Backlog OAuth has no scopes, so a token
 * carries every permission of its user: only the monolith API Lambda can
 * read the tokens, keyed by the Cognito user that the API Gateway authorizer
 * verified, and it never returns them to the browser.
 */
export class Backlog extends Construct {
  public readonly workloadIdentityName: string;

  constructor(scope: Construct, id: string, props: BacklogProps) {
    super(scope, id);

    const { apiHandler, credentialProviderName } = props;

    const workloadIdentity = new WorkloadIdentity(this, 'WorkloadIdentity', {
      workloadIdentityName: `GenUBacklog${props.env}`,
      allowedResourceOauth2ReturnUrls: props.webOrigins.map(
        (origin) => `${origin}${BACKLOG_CALLBACK_PATH}`
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
      'BACKLOG_WORKLOAD_NAME',
      workloadIdentity.workloadIdentityName
    );
    apiHandler.addEnvironment(
      'BACKLOG_CREDENTIAL_PROVIDER_NAME',
      credentialProviderName
    );
    apiHandler.addEnvironment('BACKLOG_SPACE_DOMAIN', props.spaceDomain);
    apiHandler.addEnvironment(
      'BACKLOG_ALLOWED_USERS',
      props.allowedUsers.join(',')
    );
    apiHandler.addEnvironment(
      'BACKLOG_RETURN_ORIGINS',
      props.webOrigins.join(',')
    );
    apiHandler.addEnvironment(
      'BACKLOG_IN_PROGRESS_ON_CREATE_PROJECTS',
      props.inProgressOnCreateProjects.join(',')
    );

    // API Gateway routes. Methods without an integration inherit the RestApi
    // defaultIntegration (the monolith proxy), as in the Template construct.
    const authorized: MethodOptions = {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: props.authorizer,
    };
    const root = props.api.root.addResource('backlog');
    root.addResource('status').addMethod('GET', undefined, authorized);
    root.addResource('authorize').addMethod('POST', undefined, authorized);
    root.addResource('complete').addMethod('POST', undefined, authorized);
    // The read-only lists of the Backlog page
    root.addResource('tasks').addMethod('GET', undefined, authorized);
    root.addResource('my-issues').addMethod('GET', undefined, authorized);
    root.addResource('activities').addMethod('GET', undefined, authorized);
    // The gantt chart: members of the user's projects, and their issues
    root.addResource('members').addMethod('GET', undefined, authorized);
    root.addResource('gantt').addMethod('GET', undefined, authorized);
    // Registering in Backlog (the Backlog page, after the user's OK)
    const projects = root.addResource('projects');
    projects.addMethod('GET', undefined, authorized);
    const project = projects.addResource('{projectKey}');
    project.addMethod('GET', undefined, authorized);
    project.addResource('documents').addMethod('GET', undefined, authorized);
    root.addResource('documents').addMethod('POST', undefined, authorized);
    const issues = root.addResource('issues');
    issues.addMethod('GET', undefined, authorized);
    issues.addMethod('POST', undefined, authorized);
    const issue = issues.addResource('{issueKey}');
    issue.addMethod('GET', undefined, authorized);
    issue.addResource('comments').addMethod('POST', undefined, authorized);
  }
}

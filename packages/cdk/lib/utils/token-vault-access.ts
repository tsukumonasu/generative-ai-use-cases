import { ArnFormat, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Lets a function serve the users' tokens of one OAuth2 credential provider
 * from the AgentCore Identity Token Vault (e.g. Google Workspace). Every permission is limited to the given workload
 * identity and provider.
 */
export const grantUserTokenVaultAccess = (
  scope: Construct,
  fn: IFunction,
  workloadIdentityArn: string,
  credentialProviderName: string
): void => {
  const stack = Stack.of(scope);
  const agentCoreArn = (resourceName: string) =>
    stack.formatArn({
      service: 'bedrock-agentcore',
      resource: resourceName,
      arnFormat: ArnFormat.NO_RESOURCE_NAME,
    });
  const workloadIdentityResources = [
    agentCoreArn('workload-identity-directory/default'),
    workloadIdentityArn,
  ];

  // Mint a workload access token for a user ID. AgentCore Identity treats
  // the ID as an opaque string, so the handler must take it only from the
  // authorizer claims, never from the request.
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
      resources: workloadIdentityResources,
    })
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: [
        'bedrock-agentcore:GetResourceOauth2Token',
        'bedrock-agentcore:CompleteResourceTokenAuth',
      ],
      resources: [
        ...workloadIdentityResources,
        agentCoreArn('token-vault/default'),
        agentCoreArn(
          `token-vault/default/oauth2credentialprovider/${credentialProviderName}`
        ),
      ],
    })
  );
  // The client secret AgentCore Identity stored for the provider
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        stack.formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: `bedrock-agentcore-identity!default/oauth2/${credentialProviderName}-*`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    })
  );
};

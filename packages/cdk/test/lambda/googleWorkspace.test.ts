import {
  authorize,
  complete,
  getAccessToken,
  getStatus,
  isAllowedUser,
  resolveReturnUrl,
  vaultUserId,
} from '../../lambda/googleWorkspace';
import {
  completeGoogleAuthorization,
  getGoogleToken,
} from '../../lambda/utils/googleWorkspaceIdentity';

jest.mock('../../lambda/utils/googleWorkspaceIdentity');
const mockedGetGoogleToken = getGoogleToken as jest.MockedFunction<
  typeof getGoogleToken
>;
const mockedComplete = completeGoogleAuthorization as jest.MockedFunction<
  typeof completeGoogleAuthorization
>;

const alice = {
  sub: 'sub-alice',
  username: 'EntraID_alice@example.co.jp',
  email: 'Alice@Example.co.jp',
};
const bob = {
  sub: 'sub-bob',
  username: 'EntraID_bob@example.co.jp',
  email: 'bob@example.co.jp',
};

const DEFAULT_ORIGIN = 'https://d111111abcdef8.cloudfront.net';
const ALIAS_ORIGIN = 'https://ai.example.net';

describe('Google Workspace account linking', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.GOOGLE_WORKSPACE_ALLOWED_USERS =
      'EntraID_alice@example.co.jp, EntraID_someone@example.co.jp';
    process.env.GOOGLE_WORKSPACE_RETURN_ORIGINS = `${DEFAULT_ORIGIN},${ALIAS_ORIGIN}`;
  });

  describe('isAllowedUser', () => {
    test('matches the username case-insensitively, never the email', () => {
      expect(isAllowedUser(alice)).toBe(true);
      expect(isAllowedUser(bob)).toBe(false);
      process.env.GOOGLE_WORKSPACE_ALLOWED_USERS = 'entraid_bob@example.co.jp';
      expect(isAllowedUser(bob)).toBe(true);
      process.env.GOOGLE_WORKSPACE_ALLOWED_USERS = 'bob@example.co.jp';
      expect(isAllowedUser(bob)).toBe(false);
    });

    test('allows every signed-in user with "*"', () => {
      process.env.GOOGLE_WORKSPACE_ALLOWED_USERS = '*';
      expect(isAllowedUser(alice)).toBe(true);
      expect(isAllowedUser(bob)).toBe(true);
    });

    test('allows no one while the list is empty', () => {
      process.env.GOOGLE_WORKSPACE_ALLOWED_USERS = '';
      expect(isAllowedUser(alice)).toBe(false);
    });
  });

  describe('resolveReturnUrl', () => {
    test('returns to the origin the user started from', () => {
      expect(resolveReturnUrl('https://AI.example.net')).toBe(
        `${ALIAS_ORIGIN}/google-workspace/callback`
      );
    });

    test('falls back to the first origin for an unknown or missing origin', () => {
      expect(resolveReturnUrl('https://evil.example.com')).toBe(
        `${DEFAULT_ORIGIN}/google-workspace/callback`
      );
      expect(resolveReturnUrl(undefined)).toBe(
        `${DEFAULT_ORIGIN}/google-workspace/callback`
      );
    });
  });

  test('keys the vault by the Cognito sub, partitioned by provider', () => {
    expect(vaultUserId(alice)).toBe('cognito+sub-alice');
    expect(vaultUserId(alice)).not.toBe(vaultUserId(bob));
  });

  describe('getStatus', () => {
    test('does not touch the vault for a user who is not allowed', async () => {
      const res = await getStatus(bob, DEFAULT_ORIGIN);
      expect(res).toEqual({
        statusCode: 200,
        body: { allowed: false, linked: false },
      });
      expect(mockedGetGoogleToken).not.toHaveBeenCalled();
    });

    test('reports whether a token is stored', async () => {
      mockedGetGoogleToken.mockResolvedValueOnce({ accessToken: 'ya29.x' });
      expect((await getStatus(alice, DEFAULT_ORIGIN)).body).toEqual({
        allowed: true,
        linked: true,
      });
      mockedGetGoogleToken.mockResolvedValueOnce({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?x',
      });
      expect((await getStatus(alice, DEFAULT_ORIGIN)).body).toEqual({
        allowed: true,
        linked: false,
      });
    });

    test('never puts the token in the status response', async () => {
      mockedGetGoogleToken.mockResolvedValueOnce({ accessToken: 'ya29.x' });
      const res = await getStatus(alice, DEFAULT_ORIGIN);
      expect(JSON.stringify(res)).not.toContain('ya29.x');
    });
  });

  describe('authorize', () => {
    test('is forbidden for a user who is not allowed', async () => {
      expect((await authorize(bob, DEFAULT_ORIGIN, false)).statusCode).toBe(
        403
      );
      expect(mockedGetGoogleToken).not.toHaveBeenCalled();
    });

    test('returns the consent URL, returning to the caller origin', async () => {
      mockedGetGoogleToken.mockResolvedValueOnce({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?x',
      });
      const res = await authorize(alice, ALIAS_ORIGIN, true);
      expect(res).toEqual({
        statusCode: 200,
        body: {
          linked: false,
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?x',
        },
      });
      expect(mockedGetGoogleToken).toHaveBeenCalledWith({
        userId: 'cognito+sub-alice',
        returnUrl: `${ALIAS_ORIGIN}/google-workspace/callback`,
        force: true,
      });
    });

    test('does not return the token when already linked', async () => {
      mockedGetGoogleToken.mockResolvedValueOnce({ accessToken: 'ya29.x' });
      const res = await authorize(alice, DEFAULT_ORIGIN, false);
      expect(res.body).toEqual({ linked: true });
    });
  });

  describe('complete', () => {
    test('binds the consent to the signed-in user only', async () => {
      mockedGetGoogleToken.mockResolvedValueOnce({ accessToken: 'ya29.x' });
      const res = await complete(alice, DEFAULT_ORIGIN, 'urn:session:1');
      expect(res).toEqual({ statusCode: 200, body: { linked: true } });
      expect(mockedComplete).toHaveBeenCalledWith({
        userId: 'cognito+sub-alice',
        sessionUri: 'urn:session:1',
      });
    });

    test('rejects a missing or malformed session URI', async () => {
      for (const sessionUri of [undefined, '', 42, 'x'.repeat(2049)]) {
        expect(
          (await complete(alice, DEFAULT_ORIGIN, sessionUri)).statusCode
        ).toBe(400);
      }
      expect(mockedComplete).not.toHaveBeenCalled();
    });

    test('is forbidden for a user who is not allowed', async () => {
      expect(
        (await complete(bob, DEFAULT_ORIGIN, 'urn:session:1')).statusCode
      ).toBe(403);
      expect(mockedComplete).not.toHaveBeenCalled();
    });
  });

  describe('getAccessToken', () => {
    test('serves the signed-in user their own token', async () => {
      mockedGetGoogleToken.mockResolvedValueOnce({ accessToken: 'ya29.alice' });
      const res = await getAccessToken(alice, DEFAULT_ORIGIN);
      expect(res).toEqual({
        statusCode: 200,
        body: { accessToken: 'ya29.alice' },
      });
      expect(mockedGetGoogleToken).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'cognito+sub-alice' })
      );
    });

    test('returns 409 without exposing the consent URL when not linked', async () => {
      mockedGetGoogleToken.mockResolvedValueOnce({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?x',
      });
      const res = await getAccessToken(alice, DEFAULT_ORIGIN);
      expect(res.statusCode).toBe(409);
      expect(JSON.stringify(res)).not.toContain('accounts.google.com');
    });

    test('is forbidden for a user who is not allowed', async () => {
      expect((await getAccessToken(bob, DEFAULT_ORIGIN)).statusCode).toBe(403);
      expect(mockedGetGoogleToken).not.toHaveBeenCalled();
    });
  });
});

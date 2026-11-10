import { getUserOAuth2Token } from '../../../lambda/utils/agentCoreTokenVault';

jest.mock('../../../lambda/utils/agentCoreTokenVault');
const mockedGetToken = getUserOAuth2Token as jest.MockedFunction<
  typeof getUserOAuth2Token
>;

// backlogIdentity keeps which scopes worked in module state, so each test
// loads a fresh copy
const loadModule =
  (): typeof import('../../../lambda/utils/backlogIdentity') => {
    let loaded:
      | typeof import('../../../lambda/utils/backlogIdentity')
      | undefined;
    jest.isolateModules(() => {
      loaded = require('../../../lambda/utils/backlogIdentity');
    });
    return loaded!;
  };

const validationError = () =>
  Object.assign(new Error('scopes must not be empty'), {
    name: 'ValidationException',
  });

describe('Backlog token vault access', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.BACKLOG_WORKLOAD_NAME = 'GenUBacklogdev';
    process.env.BACKLOG_CREDENTIAL_PROVIDER_NAME = 'genu-backlog';
    process.env.BACKLOG_SPACE_DOMAIN = 'example.backlog.jp';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('asks the vault for the user token with no scopes', async () => {
    mockedGetToken.mockResolvedValueOnce({ accessToken: 'backlog-token' });
    const { getBacklogToken } = loadModule();
    await expect(
      getBacklogToken({ userId: 'cognito+sub', returnUrl: 'https://x/cb' })
    ).resolves.toEqual({ accessToken: 'backlog-token' });
    expect(mockedGetToken).toHaveBeenCalledWith({
      workloadName: 'GenUBacklogdev',
      credentialProviderName: 'genu-backlog',
      scopes: [],
      userId: 'cognito+sub',
      returnUrl: 'https://x/cb',
      force: undefined,
    });
  });

  test('falls back to a placeholder scope for good when empty scopes are rejected', async () => {
    mockedGetToken
      .mockRejectedValueOnce(validationError())
      .mockResolvedValue({ accessToken: 'backlog-token' });
    const { getBacklogToken } = loadModule();
    const params = { userId: 'cognito+sub', returnUrl: 'https://x/cb' };
    await getBacklogToken(params);
    await getBacklogToken(params);
    expect(mockedGetToken.mock.calls.map(([p]) => p.scopes)).toEqual([
      [],
      ['read'],
      ['read'],
    ]);
  });

  test('does not retry other errors', async () => {
    mockedGetToken.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    );
    const { getBacklogToken } = loadModule();
    await expect(
      getBacklogToken({ userId: 'cognito+sub', returnUrl: 'https://x/cb' })
    ).rejects.toThrow('denied');
    expect(mockedGetToken).toHaveBeenCalledTimes(1);
  });

  describe('checkBacklogToken', () => {
    const respond = (status: number, body: unknown = {}) => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(body), { status })
        ) as jest.MockedFunction<typeof fetch>;
      global.fetch = fetchMock;
      return fetchMock;
    };

    test('asks the configured space who the token belongs to', async () => {
      const fetchMock = respond(200, { name: 'Taro Yamada' });
      const { checkBacklogToken } = loadModule();
      await expect(checkBacklogToken('backlog-token')).resolves.toEqual({
        valid: true,
        userName: 'Taro Yamada',
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://example.backlog.jp/api/v2/users/myself');
      expect(init?.headers).toEqual({ Authorization: 'Bearer backlog-token' });
    });

    test('treats 401 as a rejected token', async () => {
      respond(401);
      const { checkBacklogToken } = loadModule();
      await expect(checkBacklogToken('backlog-token')).resolves.toEqual({
        valid: false,
      });
    });

    test('throws when Backlog fails, which says nothing about the token', async () => {
      respond(503);
      const { checkBacklogToken } = loadModule();
      await expect(checkBacklogToken('backlog-token')).rejects.toThrow('503');
    });
  });
});

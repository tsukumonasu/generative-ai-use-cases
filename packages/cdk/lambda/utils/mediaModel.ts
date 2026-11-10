// Which image / video model a request runs on. The page lets the
// user pick one, but only models the deployment lists (cdk.json, passed as a
// JSON array env var) are accepted; anything else gets the default model.

const parseModels = (json: string | undefined): string[] => {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((m): m is string => typeof m === 'string')
      : [];
  } catch {
    return [];
  }
};

export const pickMediaModel = (
  requested: string | undefined,
  defaultModel: string,
  allowedModelsJson: string | undefined
): string =>
  requested &&
  (requested === defaultModel ||
    parseModels(allowedModelsJson).includes(requested))
    ? requested
    : defaultModel;

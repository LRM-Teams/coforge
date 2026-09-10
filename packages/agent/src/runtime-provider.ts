export const API_KEY_ENV_BY_PROVIDER = {
  deepseek: "DEEPSEEK_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
} as const;

const HOST_PROVIDER_ENV = [
  ...Object.values(API_KEY_ENV_BY_PROVIDER),
  "ANTHROPIC_OAUTH_TOKEN",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "CLOUDFLARE_ACCOUNT_ID",
];

let patchTail = Promise.resolve();
export async function withRuntimeEnvironment<T>(
  patch: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T>,
  preserveProviderAuth = false,
): Promise<T> {
  const previous = patchTail;
  let release!: () => void;
  patchTail = new Promise((resolve) => (release = resolve));
  await previous;
  const old = new Map<string, string | undefined>();
  try {
    for (const key of preserveProviderAuth ? [] : HOST_PROVIDER_ENV) {
      old.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(patch)) {
      if (HOST_PROVIDER_ENV.includes(key)) continue;
      old.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    release();
  }
}

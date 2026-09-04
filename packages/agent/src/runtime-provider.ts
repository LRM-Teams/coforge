import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const RUNTIME_PROVIDER_CONFIG_ENV = "COFORGE_RUNTIME_PROVIDER_CONFIG";

export const COFORGE_MODEL_PROVIDER_API_KEY_ENV = {
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
  ...Object.values(COFORGE_MODEL_PROVIDER_API_KEY_ENV),
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
): Promise<T> {
  const previous = patchTail;
  let release!: () => void;
  patchTail = new Promise((resolve) => (release = resolve));
  await previous;
  const old = new Map<string, string | undefined>();
  try {
    for (const key of HOST_PROVIDER_ENV) {
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

export async function seedPiSessionModelRuntime(
  modelRuntime: Pick<ModelRuntime, "setRuntimeApiKey">,
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  const raw = environment[RUNTIME_PROVIDER_CONFIG_ENV];
  delete environment[RUNTIME_PROVIDER_CONFIG_ENV];
  if (!raw) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Runtime provider config is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Runtime provider config is invalid");
  const kind = Reflect.get(value, "kind");
  if (kind === "default") return;
  const providerId = Reflect.get(value, "providerId");
  const apiKey = Reflect.get(value, "apiKey");
  if (
    kind !== "coforge" ||
    typeof providerId !== "string" ||
    !providerId ||
    typeof apiKey !== "string" ||
    apiKey.length < 8
  )
    throw new Error("Runtime provider config is invalid");
  await modelRuntime.setRuntimeApiKey(providerId, apiKey);
}

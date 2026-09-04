import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const RUNTIME_PROVIDER_CONFIG_ENV = "COFORGE_RUNTIME_PROVIDER_CONFIG";

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

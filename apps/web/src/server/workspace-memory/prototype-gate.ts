export const OPENVIKING_PROTOTYPE_FLAG = "OPENVIKING_PROTOTYPE_ENABLED" as const;

export function isOpenVikingPrototypeEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = env[OPENVIKING_PROTOTYPE_FLAG];
  return raw === "true" || raw === "1";
}

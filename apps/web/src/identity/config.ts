import type { AuthingConfig } from "./browser-login";

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export function readAuthingConfig(env: NodeJS.ProcessEnv, origin: string): AuthingConfig {
  const appId = required(env, "AUTHING_APP_ID");
  const appSecret = required(env, "AUTHING_APP_SECRET");
  const issuer = trimSlash(required(env, "AUTHING_ISSUER"));
  const redirectUri = env.AUTHING_REDIRECT_URI?.trim() || `${origin}/auth/callback`;
  return {
    appId,
    appSecret,
    issuer,
    authorizationEndpoint: `${issuer}/auth`,
    tokenEndpoint: `${issuer}/token`,
    userinfoEndpoint: `${issuer}/me`,
    endSessionEndpoint: `${issuer}/session/end`,
    redirectUri,
  };
}

export function readSessionSecret(env: NodeJS.ProcessEnv): string {
  const secret = required(env, "COFORGE_SESSION_SECRET");
  if (secret.length < 32) {
    throw new AuthConfigError("COFORGE_SESSION_SECRET must be at least 32 characters");
  }
  return secret;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new AuthConfigError(`${name} is required`);
  return value;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

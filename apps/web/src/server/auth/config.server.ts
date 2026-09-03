import { readFileSync } from "node:fs";

import type { AuthingConfig } from "./browser-login.server";

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export function readAuthingConfig(env: NodeJS.ProcessEnv, origin: string): AuthingConfig {
  const appId = required(env, "AUTHING_APP_ID");
  const appSecret = required(env, "AUTHING_APP_SECRET");
  const issuer = httpsIssuer(required(env, "AUTHING_ISSUER"));
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
  const inlineValue = env[name]?.trim();
  const fileName = `${name}_FILE`;
  const filePath = env[fileName]?.trim();
  if (inlineValue && filePath) {
    throw new AuthConfigError(`${name} and ${fileName} cannot both be set`);
  }

  let value = inlineValue;
  if (filePath) {
    try {
      value = readFileSync(filePath, "utf8").trim();
    } catch {
      throw new AuthConfigError(`${fileName} could not be read`);
    }
  }
  if (!value) throw new AuthConfigError(`${name} is required`);
  return value;
}

function httpsIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthConfigError("AUTHING_ISSUER must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new AuthConfigError("AUTHING_ISSUER must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AuthConfigError("AUTHING_ISSUER must not contain credentials, query, or fragment");
  }
  return value.replace(/\/$/, "");
}

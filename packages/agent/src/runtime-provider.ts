import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

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

/** Bun does not apply request-local Pi provider env to its process-level proxy settings. */
export function runtimeFetch(environment: Readonly<Record<string, string>>): typeof fetch {
  const request = (input: Request | string | URL, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input);
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    const bypass = (environment.no_proxy || environment.NO_PROXY || "")
      .toLowerCase()
      .split(/[,\s]+/)
      .some((entry) => {
        if (!entry) return false;
        if (entry === "*") return true;
        const match = entry.match(/^(.*):(\d+)$/);
        const host = match ? match[1]! : entry;
        if (match && match[2] !== port) return false;
        if (host.startsWith(".")) return target.hostname.endsWith(host);
        if (host.startsWith("*")) return target.hostname.endsWith(host.slice(1));
        return target.hostname === host;
      });
    const scheme = target.protocol === "https:" ? "https" : "http";
    const proxy = bypass
      ? ""
      : environment[`${scheme}_proxy`] ||
        environment[`${scheme.toUpperCase()}_PROXY`] ||
        environment.all_proxy ||
        environment.ALL_PROXY ||
        "";
    return fetch(input, { ...init, proxy });
  };
  // Bun's optional optimization must not open a direct connection around this proxy.
  return Object.assign(request, { preconnect: () => {} });
}

/** Bind only this Pi runtime; summaries resolve auth before requesting a stream. */
export function configureRuntimeEnvironment(
  runtime: ModelRuntime,
  environment: Readonly<Record<string, string>>,
): void {
  const fetch = runtimeFetch(environment);
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = (model, options) => {
    const scoped = { ...options, env: { ...options?.env, ...environment } };
    return typeof model === "string" ? getAuth(model, scoped) : getAuth(model, scoped);
  };
  const stream = runtime.stream.bind(runtime);
  runtime.stream = (model, context, options) =>
    stream(
      model,
      context,
      Object.assign({}, options, {
        env: { ...options?.env, ...environment },
        ...(model.api === "google-generative-ai" || model.api === "google-vertex" ? {} : { fetch }),
      }),
    );
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) =>
    streamSimple(model, context, {
      ...options,
      env: { ...options?.env, ...environment },
      ...(model.api === "google-generative-ai" || model.api === "google-vertex" ? {} : { fetch }),
    });
}

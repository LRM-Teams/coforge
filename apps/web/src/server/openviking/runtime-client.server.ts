import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  applyIdentityHeaderPolicy,
  decideTransportSize,
  normalizeOpenVikingPath,
  sanitizeOpenVikingTransportFailure,
  type OpenVikingTransportFailure,
  type OpenVikingTransportLimits,
  type ServerOpenVikingIdentity,
} from "./route-policy";

export type OpenVikingRuntimeRequest = {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  identity: ServerOpenVikingIdentity;
};

export type OpenVikingRuntimeResponse = {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
};

export type OpenVikingRuntimeResult =
  | { ok: true; response: OpenVikingRuntimeResponse }
  | { ok: false; failure: OpenVikingTransportFailure };

export type OpenVikingRuntimeClient = {
  request(input: OpenVikingRuntimeRequest): Promise<OpenVikingRuntimeResult>;
};

/** Call-signature only so tests can inject fetch without DOM `preconnect`. */
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function toRequestBody(body: string | Uint8Array | undefined): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy;
}

function requestByteLength(body: string | Uint8Array | undefined): number {
  if (body === undefined) return 0;
  return typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: string }).name === "AbortError"
  );
}

function responseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function limitResponseStream(
  source: ReadableStream<Uint8Array> | null,
  limits: OpenVikingTransportLimits,
): ReadableStream<Uint8Array> {
  const body =
    source ??
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        const allowed = decideTransportSize({ kind: "response", bytes: seen, limits });
        if (!allowed.ok) {
          controller.error(new Error(allowed.failure.message));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function buildRuntimeUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string> | undefined,
): URL | OpenVikingTransportFailure {
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    return sanitizeOpenVikingTransportFailure("invalid_path");
  }
  const url = new URL(path, parsedBase);
  if (url.origin !== parsedBase.origin) return sanitizeOpenVikingTransportFailure("invalid_path");
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

export function createOpenVikingRuntimeClient(options: {
  baseUrl: string;
  fetchImpl?: FetchImpl;
  limits?: OpenVikingTransportLimits;
}): OpenVikingRuntimeClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limits = options.limits ?? DEFAULT_OPENVIKING_TRANSPORT_LIMITS;

  return {
    async request(input) {
      const normalized = normalizeOpenVikingPath(input.path);
      if (!normalized.ok) return normalized;

      const size = decideTransportSize({
        kind: "request",
        bytes: requestByteLength(input.body),
        limits,
      });
      if (!size.ok) return size;

      const url = buildRuntimeUrl(options.baseUrl, normalized.path, input.query);
      if (!(url instanceof URL)) return { ok: false, failure: url };

      const headers = applyIdentityHeaderPolicy({
        incoming: input.headers ?? {},
        serverIdentity: input.identity,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: input.method.toUpperCase(),
          headers,
          body: toRequestBody(input.body),
          signal: controller.signal,
        });
        const contentLength = response.headers.get("content-length");
        if (contentLength !== null) {
          const declared = Number(contentLength);
          const declaredSize = decideTransportSize({
            kind: "response",
            bytes: Number.isFinite(declared) ? declared : Number.POSITIVE_INFINITY,
            limits,
          });
          if (!declaredSize.ok) return declaredSize;
        }
        return {
          ok: true,
          response: {
            status: response.status,
            headers: responseHeaders(response.headers),
            body: limitResponseStream(response.body, limits),
          },
        };
      } catch (error) {
        return {
          ok: false,
          failure: sanitizeOpenVikingTransportFailure(
            isAbortError(error) ? "timeout" : "runtime_unavailable",
          ),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

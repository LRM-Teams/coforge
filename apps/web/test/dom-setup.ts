import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch;
const NativeHeaders = globalThis.Headers;
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;

GlobalRegistrator.register({ url: "http://localhost/en" });

Object.assign(globalThis, {
  fetch: nativeFetch,
  Headers: NativeHeaders,
  Request: NativeRequest,
  Response: NativeResponse,
});

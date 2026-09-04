import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";
import { baseLocale, overwriteGetLocale } from "@/paraglide/runtime";

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

afterEach(() => {
  cleanup();
  overwriteGetLocale(() => baseLocale);
  window.history.replaceState({}, "", `/${baseLocale}`);
});

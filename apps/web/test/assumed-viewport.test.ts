import { describe, expect, test } from "bun:test";

import { requestIsFromPhone } from "#src/lib/assumed-viewport";

const request = (headers: Record<string, string>) => new Headers(headers);

describe("whether a request is from a phone, so its first render is the narrow layout", () => {
  test("a browser that says it is mobile is", () => {
    expect(requestIsFromPhone(request({ "sec-ch-ua-mobile": "?1" }))).toBe(true);
  });

  test("a phone's user agent is one, as MDN's browser detection advice reads it", () => {
    for (const userAgent of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
    ]) {
      expect(requestIsFromPhone(request({ "user-agent": userAgent }))).toBe(true);
    }
  });

  test("a desktop, or a tablet wide enough for the split, is not", () => {
    for (const userAgent of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      // Android tablets leave "Mobile" out.
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    ]) {
      expect(
        requestIsFromPhone(request({ "user-agent": userAgent, "sec-ch-ua-mobile": "?0" })),
      ).toBe(false);
    }
    expect(requestIsFromPhone(request({}))).toBe(false);
  });
});

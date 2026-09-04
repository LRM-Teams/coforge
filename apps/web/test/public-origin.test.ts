import { describe, expect, test } from "bun:test";

import { publicOrigin } from "@/server/http/public-origin.server";

describe("publicOrigin", () => {
  test("prefers the origin the reverse proxy reports", () => {
    const request = new Request("http://web:3000/", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "staging.coforge.cn" },
    });

    expect(publicOrigin(request)).toBe("https://staging.coforge.cn");
  });

  test("reads only the first hop of a forwarded chain", () => {
    const request = new Request("http://web:3000/", {
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "coforge.cn, internal.example",
      },
    });

    expect(publicOrigin(request)).toBe("https://coforge.cn");
  });

  test("falls back to the request URL when the proxy sends neither header", () => {
    expect(publicOrigin(new Request("http://localhost:3000/"))).toBe("http://localhost:3000");
  });

  test("ignores a forwarded protocol that arrives without a forwarded host", () => {
    const request = new Request("http://localhost:3000/", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(publicOrigin(request)).toBe("http://localhost:3000");
  });

  test("keeps an explicit port that the proxy forwards", () => {
    const request = new Request("http://web:3000/", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "coforge.cn:8443" },
    });

    expect(publicOrigin(request)).toBe("https://coforge.cn:8443");
  });

  test("rejects a forwarded host that smuggles a path", () => {
    const request = new Request("http://web:3000/", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "coforge.cn/evil" },
    });

    expect(publicOrigin(request)).toBe("http://web:3000");
  });
});

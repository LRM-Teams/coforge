import { describe, expect, test } from "bun:test";

import { publicOrigin } from "@/server/http/public-origin.server";

describe("publicOrigin", () => {
  test("prefers the origin the reverse proxy reports", () => {
    const request = new Request("http://staging.coforge.cn/", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "staging.coforge.cn" },
    });

    expect(publicOrigin(request)).toBe("https://staging.coforge.cn");
  });

  test("reads only the first hop of a forwarded chain", () => {
    const request = new Request("http://staging.coforge.cn/", {
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
    const request = new Request("http://staging.coforge.cn/", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "coforge.cn:8443" },
    });

    expect(publicOrigin(request)).toBe("https://coforge.cn:8443");
  });

  test("rejects a scheme that is not http or https", () => {
    // `new URL("file://evil.com").origin` is the literal string "null"; rendered into an
    // install command that becomes `curl -fsSL null/computer/install.sh | sh`.
    for (const scheme of ["file", "ftp", "ws", "data"]) {
      const request = new Request("http://staging.coforge.cn/", {
        headers: { "x-forwarded-proto": scheme, "x-forwarded-host": "evil.example" },
      });

      expect(publicOrigin(request)).toBe("http://staging.coforge.cn");
    }
  });

  test("rejects a forwarded host carrying only a password", () => {
    const request = new Request("http://staging.coforge.cn/", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": ":pw@evil.example" },
    });

    expect(publicOrigin(request)).toBe("http://staging.coforge.cn");
  });

  test("rejects a forwarded host that smuggles a path", () => {
    const request = new Request("http://staging.coforge.cn/", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "coforge.cn/evil" },
    });

    expect(publicOrigin(request)).toBe("http://staging.coforge.cn");
  });
});

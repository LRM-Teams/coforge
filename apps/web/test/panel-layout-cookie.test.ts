import { afterEach, describe, expect, test } from "bun:test";

import {
  panelLayoutStorage,
  storedPanelLayouts,
} from "#src/features/conversations/panel-layout-cookie";

const key = "react-resizable-panels:coforge-conversation:main:thread";
const layout = '{"main":65,"thread":35}';

/** The `name=value` pair a browser sends back for a cookie the app wrote. */
function sentBack(cookie: string): string {
  return cookie.split(";")[0]!;
}

/** What a browser sends back after the page saved `value` under `key`. */
function savedLayoutHeader(key: string, value: string) {
  browserJar();
  panelLayoutStorage({}).setItem(key, value);
  const header = globalThis.document.cookie;
  // @ts-expect-error clear the browser stub
  delete globalThis.document;
  return header;
}

/** A browser's cookie jar behind `document.cookie`: writes keep the `name=value` pair only. */
function browserJar(initial: string[] = []) {
  const jar = new Map(initial.map((pair) => pair.split("=", 2) as [string, string]));
  globalThis.document = {
    get cookie() {
      return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    set cookie(written: string) {
      const [name, value] = sentBack(written).split("=", 2) as [string, string];
      jar.set(name, value);
    },
  } as Document;
}

afterEach(() => {
  // @ts-expect-error clear the browser stub
  delete globalThis.document;
});

describe("the panel layouts a server render starts from", () => {
  test("a saved layout comes back from the cookie the browser sends", () => {
    const header = `theme=dark; ${savedLayoutHeader(key, layout)}`;
    expect(storedPanelLayouts(header)).toEqual({ [key]: layout });
  });

  test("only layouts are read: no other cookie reaches the page", () => {
    const stored = storedPanelLayouts(
      `session=secret; ${savedLayoutHeader(key, layout)}; coforge-last-location=x`,
    );
    expect(Object.keys(stored)).toEqual([key]);
    expect(JSON.stringify(stored)).not.toContain("secret");
  });

  test("a value that is not a layout is ignored rather than breaking the render", () => {
    const name = savedLayoutHeader(key, layout).split("=")[0];
    for (const value of [
      "not-json",
      encodeURIComponent("[1,2]"),
      encodeURIComponent('{"main":"wide"}'),
      encodeURIComponent('{"main":null}'),
      encodeURIComponent("null"),
      "%E0%A4%A",
    ]) {
      expect(storedPanelLayouts(`${name}=${value}`)).toEqual({});
    }
  });

  test("no cookies at all is no layouts", () => {
    expect(storedPanelLayouts(undefined)).toEqual({});
    expect(storedPanelLayouts("")).toEqual({});
  });
});

describe("panelLayoutStorage", () => {
  test("on the server, reads the layout the request carried", () => {
    const storage = panelLayoutStorage({ [key]: layout });
    expect(storage.getItem(key)).toBe(layout);
    expect(storage.getItem("react-resizable-panels:coforge-conversation:main")).toBeNull();
    expect(() => storage.setItem(key, layout)).not.toThrow();
  });

  test("in the browser, reads the live cookie, whatever the server render saw", () => {
    browserJar([savedLayoutHeader(key, '{"main":50,"thread":50}')]);
    const storage = panelLayoutStorage({ [key]: layout });
    expect(storage.getItem(key)).toBe('{"main":50,"thread":50}');
  });

  test("in the browser, a resize is written where the next request sends it", () => {
    browserJar();
    const storage = panelLayoutStorage({});
    expect(storage.getItem(key)).toBeNull();
    storage.setItem(key, layout);
    expect(storage.getItem(key)).toBe(layout);
    expect(storedPanelLayouts(globalThis.document.cookie)).toEqual({ [key]: layout });
  });
});

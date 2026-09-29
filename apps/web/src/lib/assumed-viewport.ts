/**
 * Whether a request is from a phone. The server cannot see the viewport, but the layout it renders
 * (the app's navigation, Chat's loading screen) differs between a phone and
 * a desktop in structure, and a page that hydrates a different structure than it was sent throws
 * its markup away and renders again. So the first render assumes the viewport a phone has, or a
 * desktop has, from what every request says about the browser (`Sec-CH-UA-Mobile` where the
 * browser sends it, else the `Mobi` token MDN recommends for detecting a mobile browser); a browser
 * that turns out to differ renders again with its real viewport (`useMediaQuery`).
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Browser_detection_using_the_user_agent
 */
export function requestIsFromPhone(headers: Pick<Headers, "get">): boolean {
  return headers.get("sec-ch-ua-mobile") === "?1" || /Mobi/i.test(headers.get("user-agent") ?? "");
}

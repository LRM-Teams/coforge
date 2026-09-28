import { RFC_UUID_SOURCE } from "@lrm/coforge-sdk/internal";
import { serializeWorkspaceCookie } from "#src/server/workspaces/selection.server";

const MESSAGE_TARGET = new RegExp(
  `^/messages/(?:channels/)?${RFC_UUID_SOURCE}(?:\\?view=chat#message-${RFC_UUID_SOURCE})?$`,
  "i",
);

export async function notificationOpenResponse(input: {
  request: Request;
  userId: string;
  canAccessWorkspace: (userId: string, slug: string) => Promise<boolean>;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const workspace = url.searchParams.get("workspace") ?? "";
  const target = url.searchParams.get("target") ?? "";
  if (!workspace || !MESSAGE_TARGET.test(target)) return redirect("/");
  if (!(await input.canAccessWorkspace(input.userId, workspace))) return redirect("/");
  const headers = new Headers({
    location: target,
    "cache-control": "no-store",
    "set-cookie": serializeWorkspaceCookie(workspace, url.protocol === "https:"),
  });
  return new Response(null, { status: 302, headers });
}

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

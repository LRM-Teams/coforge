import { serializeWorkspaceCookie } from "../workspaces/selection.server";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const MESSAGE_TARGET = new RegExp(`^/messages/(?:channels/)?${UUID}(?:#message-${UUID})?$`, "i");

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

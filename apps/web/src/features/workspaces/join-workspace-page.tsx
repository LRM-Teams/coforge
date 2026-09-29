import { AlertCircle, ArrowLeft } from "@untitledui/icons";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { AuthSplitLayout } from "#src/features/auth/auth-split-layout";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { inspectWorkspaceJoinLink, joinWorkspaceByLink } from "./join-links.functions";
import { workspaceInitial } from "./workspace-icon";

type JoinLinkPreview = Awaited<ReturnType<typeof inspectWorkspaceJoinLink>>;

const MARK = "\u0000";

/**
 * A message with some of its values set in bold: each value goes in as a marker and comes back
 * out as an element, so the translation keeps its own word order.
 */
function emphasized<K extends string>(
  values: Record<K, string>,
  render: (mark: (key: K) => string) => string,
): ReactNode[] {
  const byKey = new Map<string, string>(Object.entries(values));
  return render((key) => MARK + key + MARK)
    .split(MARK)
    .map((part, index) =>
      index % 2 === 1 ? (
        <strong key={index} className="font-semibold text-secondary">
          {byKey.get(part)}
        </strong>
      ) : (
        part
      ),
    );
}

/** Who is in the Workspace, Raft's way: people and Agents, either alone, or nothing when empty. */
function memberCounts({ memberCount, agentCount }: JoinLinkPreview): ReactNode[] | null {
  const members = m.workspace_join_count_members({ count: memberCount });
  const agents = m.workspace_join_count_agents({ count: agentCount });
  if (memberCount > 0 && agentCount > 0)
    return emphasized({ members, agents }, (mark) =>
      m.workspace_join_counts_both({ members: mark("members"), agents: mark("agents") }),
    );
  if (memberCount > 0 || agentCount > 0)
    return emphasized({ count: memberCount > 0 ? members : agents }, (mark) =>
      m.workspace_join_counts_one({ count: mark("count") }),
    );
  return null;
}

/**
 * The page an invite link opens (`/join/<token>`). Signed out it sends the visitor to sign in and
 * back; signed in it joins them, or takes a member straight in. A link that does not work — or
 * stops working before the join counts — says so and nothing else.
 */
export function JoinWorkspacePage({
  token,
  preview,
  viewerEmail,
}: {
  token: string;
  preview: JoinLinkPreview | null;
  viewerEmail: string | null;
}) {
  const router = useRouter();
  const [invalid, setInvalid] = useState(preview === null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, guard] = useSubmitGuard();

  if (invalid || !preview) {
    return (
      <AuthSplitLayout>
        <div className="flex w-full flex-col gap-8">
          <div className="flex flex-col items-center gap-6 text-center">
            <FeaturedIcon icon={AlertCircle} color="error" theme="light" size="lg" />
            <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
              {m.workspace_join_invalid_title()}
            </h1>
          </div>
          <p
            role="alert"
            className="rounded-lg bg-error-primary px-4 py-3 text-sm text-error-primary ring-1 ring-error_subtle"
          >
            {m.workspace_join_invalid_description()}
          </p>
          <Button
            size="lg"
            color="secondary"
            iconLeading={ArrowLeft}
            className="w-full"
            onPress={() => void router.navigate({ to: "/" })}
          >
            {m.workspace_join_back()}
          </Button>
        </div>
      </AuthSplitLayout>
    );
  }

  const { workspace } = preview;
  const counts = memberCounts(preview);
  const openWorkspace = (slug: string) =>
    router.navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug: slug } });

  function join() {
    void guard(async () => {
      setProblem(null);
      try {
        const joined = await joinWorkspaceByLink({ data: { token } });
        await openWorkspace(joined.slug);
      } catch (error) {
        // Revoked, expired or used up since the page loaded.
        if (isAppError(error) && error.code === "NOT_FOUND") setInvalid(true);
        else setProblem(m.workspace_join_failed());
      }
    });
  }

  return (
    <AuthSplitLayout>
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <Avatar
            size="xl"
            src={workspace.iconUrl}
            alt=""
            initials={workspaceInitial(workspace.name)}
            border
          />
          <div className="flex flex-col gap-2 md:gap-3">
            <h1 className="text-display-xs font-semibold break-words text-primary md:text-display-sm">
              {m.workspace_join_title({ name: workspace.name })}
            </h1>
            <p className="text-md break-words text-tertiary">
              {emphasized({ name: workspace.name }, (mark) =>
                m.workspace_join_description({ name: mark("name") }),
              )}
            </p>
            {counts ? <p className="text-sm text-quaternary">{counts}</p> : null}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {viewerEmail === null ? (
            <Button
              size="lg"
              className="w-full"
              onPress={() =>
                void router.navigate({ to: "/login", search: { returnTo: `/join/${token}` } })
              }
            >
              {m.workspace_join_sign_in()}
            </Button>
          ) : preview.viewerIsMember ? (
            <Button size="lg" className="w-full" onPress={() => void openWorkspace(workspace.slug)}>
              {m.workspace_join_open({ name: workspace.name })}
            </Button>
          ) : (
            <Button size="lg" className="w-full" isLoading={pending} onPress={join}>
              {m.workspace_join_submit({ name: workspace.name })}
            </Button>
          )}
          {problem ? (
            <HintText isInvalid role="alert" className="text-center">
              {problem}
            </HintText>
          ) : null}
        </div>

        {viewerEmail === null ? null : (
          <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-center text-xs text-quaternary">
            <span className="break-all">
              {emphasized({ email: viewerEmail }, (mark) =>
                m.workspace_join_signed_in_as({ email: mark("email") }),
              )}
            </span>
            <span aria-hidden="true">·</span>
            {/* Signing out goes through Authing and lands on the homepage. */}
            <Button
              color="link-gray"
              size="sm"
              onPress={() => window.location.assign("/auth/logout")}
            >
              {m.workspace_join_switch_account()}
            </Button>
          </p>
        )}
      </div>
    </AuthSplitLayout>
  );
}

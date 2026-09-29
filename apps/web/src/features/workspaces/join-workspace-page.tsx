import { AlertCircle, ArrowLeft } from "@untitledui/icons";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { AuthSplitLayout } from "#src/features/auth/auth-split-layout";
import { signOut } from "#src/features/auth/sign-out";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { joinFailure, type JoinFailure } from "./join-failure";
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
  const [problem, setProblem] = useState<Exclude<JoinFailure, { kind: "link-invalid" }> | null>(
    null,
  );
  const [pending, guard] = useSubmitGuard();

  if (invalid || !preview) {
    return (
      <AuthSplitLayout>
        <div className="flex w-full flex-col gap-8">
          <div className="flex flex-col items-center gap-6 text-center">
            <FeaturedIcon icon={AlertCircle} color="error" theme="light" size="lg" />
            <div className="flex flex-col gap-2 md:gap-3">
              <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
                {m.workspace_join_invalid_title()}
              </h1>
              <HintText isInvalid role="alert" className="text-md text-balance">
                {m.workspace_join_invalid_description()}
              </HintText>
            </div>
          </div>
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
  const signIn = () =>
    void router.navigate({ to: "/login", search: { returnTo: `/join/${token}` } });

  function join() {
    void guard(async () => {
      setProblem(null);
      try {
        const joined = await joinWorkspaceByLink({ data: { token } });
        await openWorkspace(joined.slug);
      } catch (error) {
        const failure = joinFailure(error);
        // Revoked, expired or used up since the page loaded.
        if (failure.kind === "link-invalid") setInvalid(true);
        else setProblem(failure);
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
          {viewerEmail === null || problem?.kind === "signed-out" ? (
            <Button size="lg" className="w-full" onPress={signIn}>
              {problem ? m.login_retry() : m.workspace_join_sign_in()}
            </Button>
          ) : preview.viewerIsMember ? (
            <Button size="lg" className="w-full" onPress={() => void openWorkspace(workspace.slug)}>
              {m.workspace_join_open({ name: workspace.name })}
            </Button>
          ) : (
            <Button size="lg" className="w-full" isLoading={pending} onPress={join}>
              {problem ? m.controls_retry() : m.workspace_join_submit({ name: workspace.name })}
            </Button>
          )}
          {problem ? (
            <div className="flex flex-col items-center gap-1 text-center">
              <HintText isInvalid role="alert">
                {problem.kind === "signed-out"
                  ? m.workspace_join_signed_out()
                  : problem.kind === "server-error"
                    ? m.workspace_join_server_failed()
                    : m.workspace_join_failed()}
              </HintText>
              {problem.kind === "server-error" && problem.errorId ? (
                <p className="text-xs text-tertiary">
                  {m.error_reference({ errorId: problem.errorId })}
                </p>
              ) : null}
            </div>
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
            {/* Signing out goes through Authing, then straight back to sign-in and this page. */}
            <Button
              color="link-gray"
              size="sm"
              onPress={() =>
                void signOut(`/auth/logout?returnTo=${encodeURIComponent(`/join/${token}`)}`)
              }
            >
              {m.workspace_join_switch_account()}
            </Button>
          </p>
        )}
      </div>
    </AuthSplitLayout>
  );
}

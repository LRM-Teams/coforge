import { useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy01 as Copy } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { formatMonthDay } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import {
  defaultJoinLinkChoices,
  JOIN_LINK_LIFETIME_DAYS,
  JOIN_LINK_USE_LIMITS,
  joinLinkOptions,
  type JoinLinkChoices,
  type JoinLinkExpiryChoice,
  type JoinLinkMaxUsesChoice,
} from "./join-link-options";
import {
  createWorkspaceJoinLink,
  loadWorkspaceJoinLink,
  replaceWorkspaceJoinLink,
  revokeWorkspaceJoinLink,
} from "./join-links.functions";

const appRoute = getRouteApi("/w/$workspaceSlug");

/** How long the copy button shows its check after a copy. */
const COPIED_FEEDBACK_MS = 1_500;

type JoinLink = NonNullable<Awaited<ReturnType<typeof loadWorkspaceJoinLink>>>;
type JoinLinkOptions = { maxUses: number | null; expiresAt: string | null };

type JoinLinkState =
  | { status: "idle" | "loading" | "failed" }
  /** `link` is null once the link is revoked and no new one is made yet. */
  | { status: "ready"; link: JoinLink | null };

/** The link tab's Workspace join link. The dialog prepares it the first time the tab shows —
 * making an unlimited, never-expiring one when there is none, so there is always a link to copy —
 * and resets it on close, since it may be used or replaced before the dialog opens again. */
export function useInviteLink() {
  const load = useServerFn(loadWorkspaceJoinLink);
  const create = useServerFn(createWorkspaceJoinLink);
  const replace = useServerFn(replaceWorkspaceJoinLink);
  const revoke = useServerFn(revokeWorkspaceJoinLink);
  const [state, setState] = useState<JoinLinkState>({ status: "idle" });
  // A close or a newer prepare makes an answer still on its way stale.
  const generation = useRef(0);

  async function prepare() {
    const run = ++generation.current;
    setState({ status: "loading" });
    try {
      const link = (await load()) ?? (await create({ data: { maxUses: null, expiresAt: null } }));
      if (run === generation.current) setState({ status: "ready", link });
    } catch {
      if (run === generation.current) setState({ status: "failed" });
    }
  }

  /** Runs a change and shows the link it leaves; a failure is the caller's to show. */
  async function change(action: () => Promise<JoinLink | null>) {
    const run = generation.current;
    const link = await action();
    if (run === generation.current) setState({ status: "ready", link });
  }

  return {
    state,
    /** Prepares the link unless it is already prepared or on its way. */
    show() {
      if (state.status === "idle") void prepare();
    },
    retry: prepare,
    reset() {
      generation.current += 1;
      setState({ status: "idle" });
    },
    update: (linkId: string, options: JoinLinkOptions) =>
      change(() => replace({ data: { linkId, ...options } })),
    revoke: (linkId: string) =>
      change(async () => {
        await revoke({ data: { linkId } });
        return null;
      }),
    create: (options: JoinLinkOptions) => change(() => create({ data: options })),
  };
}

export type InviteLink = ReturnType<typeof useInviteLink>;

/** The invite dialog's "By link" tab, after Raft's: copy the link, change its limits by
 * replacing it, or revoke it. */
export function InviteLinkPanel({
  inviteLink,
  onDone,
}: {
  inviteLink: InviteLink;
  onDone: () => void;
}) {
  const { state } = inviteLink;
  const link = state.status === "ready" ? state.link : undefined;
  // A new link starts from its own settings; a revoked one from no limit and never.
  return (
    <InviteLinkForm
      key={link === undefined ? "pending" : (link?.id ?? "none")}
      inviteLink={inviteLink}
      link={link}
      onDone={onDone}
    />
  );
}

type Action = "update" | "revoke" | "create";

function InviteLinkForm({
  inviteLink,
  link,
  onDone,
}: {
  inviteLink: InviteLink;
  /** undefined while the link is being prepared or could not be. */
  link: JoinLink | null | undefined;
  onDone: () => void;
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const locale = getLocale();
  const [choices, setChoices] = useState<JoinLinkChoices>(() =>
    defaultJoinLinkChoices(link ?? null),
  );
  const [busy, setBusy] = useState<Action | null>(null);
  const [failed, setFailed] = useState<Action | null>(null);
  const [copied, setCopied] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const url = link ? `${window.location.origin}/join/${link.token}` : "";
  const preparing = inviteLink.state.status === "idle" || inviteLink.state.status === "loading";
  const prepareFailed = inviteLink.state.status === "failed";
  const status = link
    ? [
        link.maxUses !== null &&
          m.workspace_join_link_used({ used: link.useCount, limit: link.maxUses }),
        link.expiresAt &&
          m.workspace_join_link_expires({ date: formatMonthDay(link.expiresAt, timeZone, locale) }),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Without clipboard access, select the link so the person can copy it themselves.
      urlRef.current?.focus();
      urlRef.current?.select();
    }
  }

  async function run(action: Action, perform: () => Promise<void>) {
    setBusy(action);
    setFailed(null);
    try {
      await perform();
    } catch {
      setFailed(action);
    } finally {
      setBusy(null);
    }
  }

  const options = () => joinLinkOptions(choices, link ?? null, new Date(), timeZone);

  const maxUsesItems = [
    ...(link?.maxUses != null ? [{ id: "keep", label: m.workspace_join_link_keep() }] : []),
    { id: "unlimited", label: m.workspace_join_link_unlimited() },
    ...JOIN_LINK_USE_LIMITS.map((count) => ({ id: String(count), label: String(count) })),
  ];
  const expiryItems = [
    ...(link?.expiresAt ? [{ id: "keep", label: m.workspace_join_link_keep() }] : []),
    { id: "never", label: m.workspace_join_link_never() },
    ...JOIN_LINK_LIFETIME_DAYS.map((days) => ({
      id: String(days),
      label: m.workspace_join_link_days({ count: days }),
    })),
  ];
  const controlsDisabled = link === undefined || busy !== null;

  return (
    <>
      <div className="grid gap-5 px-6 py-6">
        <div className="grid gap-1.5">
          {link === null ? (
            <p className="text-sm text-tertiary">{m.workspace_join_link_empty()}</p>
          ) : (
            <>
              <div className="flex items-end gap-2">
                <Input
                  ref={urlRef}
                  label={m.workspace_join_link_label()}
                  value={url}
                  placeholder={preparing ? m.workspace_join_link_preparing() : undefined}
                  isReadOnly
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  color="secondary"
                  size="md"
                  iconLeading={copied ? Check : Copy}
                  aria-label={m.workspace_join_link_copy()}
                  isDisabled={!link}
                  onPress={copy}
                />
              </div>
              {prepareFailed ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p role="alert" className="text-sm text-error-primary">
                    {m.workspace_join_link_prepare_failed()}
                  </p>
                  <Button color="link-color" size="sm" onPress={() => void inviteLink.retry()}>
                    {m.controls_retry()}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-tertiary">{m.workspace_join_link_hint()}</p>
              )}
              {status && <p className="text-sm text-tertiary">{status}</p>}
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select
            label={m.workspace_join_link_max_uses()}
            items={maxUsesItems}
            selectedKey={String(choices.maxUses)}
            isDisabled={controlsDisabled}
            onSelectionChange={(key) => {
              const next = parseMaxUses(String(key));
              if (next !== undefined) setChoices((current) => ({ ...current, maxUses: next }));
            }}
          >
            {(item) => <Select.Item id={item.id} label={item.label} />}
          </Select>
          <Select
            label={m.workspace_join_link_expiry()}
            items={expiryItems}
            selectedKey={String(choices.expiry)}
            isDisabled={controlsDisabled}
            onSelectionChange={(key) => {
              const next = parseExpiry(String(key));
              if (next !== undefined) setChoices((current) => ({ ...current, expiry: next }));
            }}
          >
            {(item) => <Select.Item id={item.id} label={item.label} />}
          </Select>
        </div>

        <div className="grid justify-items-start gap-1.5">
          {link === null ? (
            <Button
              color="primary"
              size="sm"
              isDisabled={busy !== null}
              isLoading={busy === "create"}
              showTextWhileLoading
              onPress={() => void run("create", () => inviteLink.create(options()))}
            >
              {m.workspace_join_link_create()}
            </Button>
          ) : (
            <Button
              color="secondary"
              size="sm"
              isDisabled={controlsDisabled}
              isLoading={busy === "update"}
              showTextWhileLoading
              onPress={() => {
                if (link) void run("update", () => inviteLink.update(link.id, options()));
              }}
            >
              {m.workspace_join_link_update()}
            </Button>
          )}
          {failed === "update" || failed === "create" ? (
            <p role="alert" className="text-sm text-error-primary">
              {failed === "update"
                ? m.workspace_join_link_update_failed()
                : m.workspace_join_link_create_failed()}
            </p>
          ) : (
            link !== null && (
              <p className="text-sm text-tertiary">{m.workspace_join_link_update_hint()}</p>
            )
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-secondary px-6 py-4">
        <div className="grid justify-items-start gap-1.5">
          {link && (
            <Button
              color="link-destructive"
              size="sm"
              isDisabled={busy !== null}
              isLoading={busy === "revoke"}
              showTextWhileLoading
              onPress={() => void run("revoke", () => inviteLink.revoke(link.id))}
            >
              {m.workspace_join_link_revoke()}
            </Button>
          )}
          {failed === "revoke" && (
            <p role="alert" className="text-sm text-error-primary">
              {m.workspace_join_link_revoke_failed()}
            </p>
          )}
        </div>
        <Button type="button" color="secondary" onPress={onDone}>
          {m.workspace_invite_done()}
        </Button>
      </div>
    </>
  );
}

function parseMaxUses(key: string): JoinLinkMaxUsesChoice | undefined {
  if (key === "keep" || key === "unlimited") return key;
  return JOIN_LINK_USE_LIMITS.find((count) => String(count) === key);
}

function parseExpiry(key: string): JoinLinkExpiryChoice | undefined {
  if (key === "keep" || key === "never") return key;
  return JOIN_LINK_LIFETIME_DAYS.find((days) => String(days) === key);
}

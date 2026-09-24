import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Heading, Text } from "react-aria-components";
import {
  Archive,
  Check,
  ChevronRight,
  EyeOff,
  LogOut01 as LogOut,
  RefreshCcw01 as Unarchive,
  Share04 as Share,
} from "@untitledui/icons";

import {
  Dialog as SlideoutDialog,
  Modal as SlideoutModal,
  ModalOverlay as SlideoutOverlay,
  SlideoutMenu,
} from "#src/components/application/slideout-menus/slideout-menu";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Avatar } from "#src/components/base/avatar/avatar";
import { AvatarAddButton } from "#src/components/base/avatar/base-components/avatar-add-button";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Toggle } from "#src/components/base/toggle/toggle";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { Skeleton } from "#src/components/ui/skeleton";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type { ChannelConversationView } from "./channel-conversation";
import { ChannelMembersDialog } from "./channel-members-dialog";
import {
  leavePublicChannel,
  loadPublicChannelMembers,
  setGeneralChannelHidden,
  setPublicChannelArchived,
  setPublicChannelMuted,
  setPublicConversationPinned,
  updatePublicChannelInfo,
} from "./channels.functions";
import { channelMembersQueryKey } from "./conversation-query-keys";

/** How many member avatars the strip shows before the "+N" tile. */
const MEMBER_STRIP_LIMIT = 14;
const SAVED_NOTICE_MS = 1500;

/** The channel actions that ask for confirmation first. */
type ConfirmedAction = "archive" | "leave" | "hide-general";

/**
 * The channel header's details-and-settings slideout: identity, the Members strip, the Info form
 * (name and description, for channel admins), the viewer's own preferences (pin, mute), and the
 * channel actions (archive, leave; hiding #general for an owner or admin). Closing with unsaved
 * Info edits asks first.
 */
export function ChannelSettingsPanel({
  conversation,
  open,
  onOpenChange,
  onChanged,
  onOpenAgentProfile,
}: {
  conversation: ChannelConversationView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refreshes the page and the sidebar after a write changed the channel or the membership. */
  onChanged: () => Promise<void>;
  /** Opens the Agent profile panel from the Members dialog (this panel closes first). */
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const channelId = conversation.conversationId;
  const capabilities = conversation.channelCapabilities;
  const isMember = Boolean(conversation.senderMemberId);
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);
  const [unsavedPromptOpen, setUnsavedPromptOpen] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmedAction | null>(null);
  const info = useInfoForm(conversation, onChanged);
  // What to do once the panel has closed, held while unsaved edits are being confirmed.
  const afterClose = useRef<(() => void) | undefined>(undefined);

  function close() {
    onOpenChange(false);
    afterClose.current?.();
    afterClose.current = undefined;
  }

  /** Every way out of the panel comes through here, so unsaved Info edits always ask first. */
  function requestClose(then?: () => void) {
    afterClose.current = then;
    if (info.dirty) setUnsavedPromptOpen(true);
    else close();
  }

  return (
    <>
      <SlideoutOverlay
        isOpen={open}
        isDismissable
        onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
      >
        <SlideoutModal className="max-w-136">
          <SlideoutDialog aria-label={m.channel_settings_open()} className="gap-0">
            <SlideoutMenu.Header
              onClose={() => requestClose()}
              className="border-b border-secondary pb-4"
            >
              <div className="flex min-w-0 items-center gap-2 pr-8">
                <Heading slot="title" className="truncate text-lg font-semibold text-primary">
                  #{conversation.name}
                </Heading>
                <Badge size="sm" color="gray" className="shrink-0">
                  {m.channel_settings_public()}
                </Badge>
              </div>
              {conversation.description && (
                <p className="mt-1 truncate text-sm text-tertiary">{conversation.description}</p>
              )}
            </SlideoutMenu.Header>
            <SlideoutMenu.Content className="gap-0 pb-6">
              <MembersStrip
                channelId={channelId}
                canAdd={isMember && !conversation.archived}
                onOpenMembers={() => setMembersDialogOpen(true)}
              />
              {(capabilities.update || conversation.project) && (
                <PanelSection title={m.channel_settings_info()}>
                  {capabilities.update && (
                    <InfoForm
                      form={info}
                      channelName={conversation.name}
                      archived={conversation.archived}
                    />
                  )}
                  {conversation.project && <ProjectField project={conversation.project} />}
                </PanelSection>
              )}
              {isMember && <PreferencesSection conversation={conversation} onChanged={onChanged} />}
              {(capabilities.archive ||
                capabilities.unarchive ||
                capabilities.leave ||
                conversation.canHideGeneral) && (
                <ActionsSection
                  conversation={conversation}
                  onConfirm={setConfirming}
                  onChanged={onChanged}
                />
              )}
            </SlideoutMenu.Content>
          </SlideoutDialog>
        </SlideoutModal>
      </SlideoutOverlay>
      {membersDialogOpen && (
        <ChannelMembersDialog
          channelId={channelId}
          open={membersDialogOpen}
          onOpenChange={setMembersDialogOpen}
          onOpenAgentProfile={
            onOpenAgentProfile
              ? (agentId: string) => {
                  setMembersDialogOpen(false);
                  requestClose(() => onOpenAgentProfile(agentId));
                }
              : undefined
          }
        />
      )}
      <UnsavedChangesDialog
        open={unsavedPromptOpen}
        saving={info.saving}
        onKeepEditing={() => {
          afterClose.current = undefined;
          setUnsavedPromptOpen(false);
        }}
        onDiscard={() => {
          info.reset();
          setUnsavedPromptOpen(false);
          close();
        }}
        onSaveAndClose={async () => {
          const saved = await info.save();
          setUnsavedPromptOpen(false);
          if (saved) close();
          else afterClose.current = undefined;
        }}
      />
      <ChannelActionConfirmDialog
        kind={confirming}
        channelId={channelId}
        channelName={conversation.name}
        onClose={() => setConfirming(null)}
        onDone={async () => {
          setConfirming(null);
          onOpenChange(false);
          // After hiding #general the page's refetch answers NOT_FOUND, which leaves for Chat.
          await onChanged();
        }}
      />
    </>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-secondary py-5 first:border-t-0">
      <h3 className="text-md font-semibold text-primary">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function MembersStrip({
  channelId,
  canAdd,
  onOpenMembers,
}: {
  channelId: string;
  canAdd: boolean;
  onOpenMembers: () => void;
}) {
  const load = useServerFn(loadPublicChannelMembers);
  const members = useQuery({
    queryKey: channelMembersQueryKey(channelId),
    queryFn: () => load({ data: { channelId } }),
    refetchOnWindowFocus: true,
  });
  const humans = members.data?.humans ?? [];
  const agents = members.data?.agents ?? [];
  const entries = [
    ...humans.map((human) => ({ key: `user:${human.id}`, ...human })),
    ...agents.map((agent) => ({ key: `agent:${agent.id}`, ...agent })),
  ];
  const shown = entries.slice(0, MEMBER_STRIP_LIMIT);
  const more = entries.length - shown.length;
  return (
    <section className="py-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-md font-semibold text-primary">{m.channel_settings_members()}</h3>
        <Button
          color="link-gray"
          size="sm"
          iconTrailing={ChevronRight}
          className="min-w-0"
          onPress={onOpenMembers}
        >
          {members.data
            ? `${m.channel_settings_humans({ count: humans.length })} · ${m.channel_settings_agents({ count: agents.length })}`
            : m.channel_members_loading()}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2" aria-busy={members.isPending}>
        {members.isPending &&
          Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="size-8 rounded-full" />
          ))}
        {members.isError && (
          <p role="alert" className="text-sm text-error-primary">
            {m.channel_members_load_error()}
          </p>
        )}
        {shown.map((entry) => (
          <Tooltip key={entry.key} title={entry.displayName}>
            <TooltipTrigger className="shrink-0 rounded-full" onPress={onOpenMembers}>
              <Avatar
                size="sm"
                alt=""
                src={entry.avatarUrl ?? undefined}
                initials={avatarInitial(entry.displayName)}
                contentClassName={avatarToneClassName(entry.displayName)}
              />
              <span className="sr-only">{entry.displayName}</span>
            </TooltipTrigger>
          </Tooltip>
        ))}
        {more > 0 && (
          <Tooltip title={m.channel_settings_members_more({ count: more })}>
            <TooltipTrigger className="shrink-0 rounded-full" onPress={onOpenMembers}>
              <Avatar size="sm" alt="" initials={`+${more}`} />
              <span className="sr-only">{m.channel_settings_members_more({ count: more })}</span>
            </TooltipTrigger>
          </Tooltip>
        )}
        {canAdd && members.data && (
          <AvatarAddButton
            size="sm"
            title={m.channel_settings_add_members()}
            onPress={onOpenMembers}
          />
        )}
      </div>
    </section>
  );
}

type InfoForm = ReturnType<typeof useInfoForm>;

/** The Info form's draft and save state. The draft follows the channel until it is edited, so a
 * rename made elsewhere shows up here while nothing is being typed. */
function useInfoForm(conversation: ChannelConversationView, onChanged: () => Promise<void>) {
  const update = useServerFn(updatePublicChannelInfo);
  const [name, setName] = useState(conversation.name);
  const [description, setDescription] = useState(conversation.description);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Compare normalized values on both sides. Channel values can carry incidental surrounding
  // whitespace from older edits; that must not make a freshly opened form look dirty.
  const dirty =
    name.trim() !== conversation.name.trim() ||
    description.trim() !== conversation.description.trim();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (dirtyRef.current) return;
    setName(conversation.name);
    setDescription(conversation.description);
  }, [conversation.name, conversation.description]);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  function edit(apply: () => void) {
    apply();
    setError("");
    setSaved(false);
  }

  return {
    name,
    description,
    dirty,
    saving,
    saved,
    error,
    setName: (value: string) => edit(() => setName(value)),
    setDescription: (value: string) => edit(() => setDescription(value)),
    reset() {
      setName(conversation.name);
      setDescription(conversation.description);
      setError("");
    },
    /** Resolves `true` once the channel holds the draft. */
    async save(): Promise<boolean> {
      if (!dirty) return true;
      setSaving(true);
      setError("");
      try {
        const trimmedName = name.trim();
        const trimmedDescription = description.trim();
        await update({
          data: {
            channelId: conversation.conversationId,
            ...(trimmedName !== conversation.name ? { name: trimmedName } : {}),
            ...(trimmedDescription !== conversation.description
              ? { description: trimmedDescription }
              : {}),
          },
        });
        await onChanged();
        setName(trimmedName);
        setDescription(trimmedDescription);
        setSaved(true);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), SAVED_NOTICE_MS);
        return true;
      } catch (cause) {
        setError(infoSaveError(cause));
        return false;
      } finally {
        setSaving(false);
      }
    },
  };
}

function infoSaveError(cause: unknown) {
  if (!isAppError(cause)) return m.channel_settings_save_error();
  if (cause.code === "CONFLICT") return m.channel_conflict();
  if (cause.code === "INVALID_INPUT") return m.channel_name_hint();
  if (cause.code === "ACCESS_DENIED") return m.channel_settings_access_denied();
  return m.channel_settings_save_error();
}

function InfoForm({
  form,
  channelName,
  archived,
}: {
  form: InfoForm;
  channelName: string;
  /** An archived channel's name and description are frozen until it is unarchived. */
  archived: boolean;
}) {
  const isGeneral = channelName === "general";
  const locked = archived || form.saving;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.save();
      }}
    >
      <Input
        label={m.channel_settings_name()}
        placeholder={m.channel_settings_name_placeholder()}
        value={form.name}
        onChange={form.setName}
        isRequired
        isDisabled={isGeneral || locked}
        hint={isGeneral ? m.channel_settings_general_cannot_rename() : m.channel_name_hint()}
      />
      <TextArea
        label={m.channel_settings_description()}
        placeholder={m.channel_settings_description_placeholder()}
        value={form.description}
        onChange={form.setDescription}
        isDisabled={locked}
        rows={2}
      />
      {form.error && (
        <p role="alert" className="text-sm text-error-primary">
          {form.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" color="secondary" isDisabled={!form.dirty || locked} onPress={form.reset}>
          {m.channel_settings_cancel()}
        </Button>
        <Button
          type="submit"
          size="sm"
          iconLeading={form.saved ? Check : undefined}
          isDisabled={!form.dirty || locked}
          isLoading={form.saving}
          showTextWhileLoading
        >
          {form.saving
            ? m.channel_settings_saving()
            : form.saved
              ? m.channel_settings_saved()
              : m.channel_settings_save()}
        </Button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {form.saved ? m.channel_settings_saved() : ""}
      </span>
    </form>
  );
}

function ProjectField({ project }: { project: NonNullable<ChannelConversationView["project"]> }) {
  return (
    <div className="mt-4 first:mt-0">
      <p className="text-sm text-tertiary">{m.channel_settings_project()}</p>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="truncate font-medium text-primary">{project.name}</span>
        {project.githubHtmlUrl && project.githubFullName && (
          <a
            href={project.githubHtmlUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={m.channel_settings_view_repository({ repository: project.githubFullName })}
            className="inline-flex min-w-0 items-center gap-1 text-brand-secondary hover:underline"
          >
            <span className="truncate">{project.githubFullName}</span>
            <Share aria-hidden="true" className="size-3.5 shrink-0" />
          </a>
        )}
      </div>
    </div>
  );
}

function PreferencesSection({
  conversation,
  onChanged,
}: {
  conversation: ChannelConversationView;
  onChanged: () => Promise<void>;
}) {
  const setPinned = useServerFn(setPublicConversationPinned);
  const setMuted = useServerFn(setPublicChannelMuted);
  const [pending, setPending] = useState<"pin" | "mute" | null>(null);
  const [error, setError] = useState("");
  const channelId = conversation.conversationId;

  async function change(which: "pin" | "mute", write: () => Promise<unknown>) {
    setPending(which);
    setError("");
    try {
      await write();
      await onChanged();
    } catch {
      setError(m.channel_settings_preference_error());
    } finally {
      setPending(null);
    }
  }

  return (
    <PanelSection title={m.channel_settings_preferences()}>
      <div className="divide-y divide-secondary">
        <PreferenceRow
          title={m.channel_settings_pin()}
          description={m.channel_settings_pin_description()}
        >
          <Toggle
            size="md"
            aria-label={m.channel_settings_pin()}
            isSelected={conversation.pinned}
            isDisabled={pending !== null}
            onChange={(pinned) =>
              void change("pin", () => setPinned({ data: { channelId, pinned } }))
            }
          />
        </PreferenceRow>
        <PreferenceRow
          title={m.channel_settings_mute()}
          description={m.channel_settings_mute_description()}
        >
          <Toggle
            size="md"
            aria-label={m.channel_settings_mute()}
            isSelected={conversation.muted}
            isDisabled={pending !== null}
            onChange={(muted) =>
              void change("mute", () => setMuted({ data: { channelId, muted } }))
            }
          />
        </PreferenceRow>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-primary">
          {error}
        </p>
      )}
    </PanelSection>
  );
}

function PreferenceRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary">{title}</p>
        <p className="mt-0.5 text-sm text-tertiary">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ActionsSection({
  conversation,
  onConfirm,
  onChanged,
}: {
  conversation: ChannelConversationView;
  onConfirm: (kind: ConfirmedAction) => void;
  onChanged: () => Promise<void>;
}) {
  const setArchived = useServerFn(setPublicChannelArchived);
  const [unarchiving, setUnarchiving] = useState(false);
  const [error, setError] = useState("");
  const capabilities = conversation.channelCapabilities;

  async function unarchive() {
    setUnarchiving(true);
    setError("");
    try {
      await setArchived({ data: { channelId: conversation.conversationId, archived: false } });
      await onChanged();
    } catch {
      setError(m.channel_settings_unarchive_error());
    } finally {
      setUnarchiving(false);
    }
  }

  return (
    <PanelSection title={m.channel_settings_actions()}>
      <div className="flex flex-col gap-2">
        {conversation.archived
          ? capabilities.unarchive && (
              <Button
                color="secondary"
                iconLeading={Unarchive}
                className="w-full"
                isDisabled={unarchiving}
                isLoading={unarchiving}
                showTextWhileLoading
                onPress={() => void unarchive()}
              >
                {unarchiving ? m.channel_settings_unarchiving() : m.channel_settings_unarchive()}
              </Button>
            )
          : capabilities.archive && (
              <Button
                color="secondary-destructive"
                iconLeading={Archive}
                className="w-full"
                onPress={() => onConfirm("archive")}
              >
                {m.channel_settings_archive()}
              </Button>
            )}
        {/* A Workspace owner or admin may hide #general from the whole Workspace (restored from
            Settings → System channels). */}
        {conversation.canHideGeneral && (
          <Button
            color="secondary-destructive"
            iconLeading={EyeOff}
            className="w-full"
            onPress={() => onConfirm("hide-general")}
          >
            {m.channel_settings_hide_general()}
          </Button>
        )}
        {capabilities.leave && !conversation.archived && (
          <Button
            color="secondary-destructive"
            iconLeading={LogOut}
            className="w-full"
            onPress={() => onConfirm("leave")}
          >
            {m.channel_settings_leave()}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-primary">
          {error}
        </p>
      )}
    </PanelSection>
  );
}

const CONFIRM_COPY: Record<
  ConfirmedAction,
  {
    title: () => string;
    body: (name: string) => string;
    confirm: () => string;
    pending: () => string;
    error: () => string;
  }
> = {
  archive: {
    title: m.channel_settings_archive,
    body: (name) => m.channel_settings_archive_confirm({ name }),
    confirm: m.channel_settings_archive_action,
    pending: m.channel_settings_archiving,
    error: m.channel_settings_archive_error,
  },
  leave: {
    title: m.channel_settings_leave,
    body: (name) => m.channel_settings_leave_confirm({ name }),
    confirm: m.channel_settings_leave_action,
    pending: m.channel_settings_leaving,
    error: m.channel_settings_leave_error,
  },
  "hide-general": {
    title: m.channel_settings_hide_general,
    body: () => m.channel_settings_hide_general_confirm(),
    confirm: m.channel_settings_hide_general,
    pending: m.channel_settings_hiding_general,
    error: m.channel_settings_hide_general_error,
  },
};

/** Confirms archiving or leaving the channel, or hiding #general; the write runs here so its
 * error stays inline. */
function ChannelActionConfirmDialog({
  kind,
  channelId,
  channelName,
  onClose,
  onDone,
}: {
  kind: ConfirmedAction | null;
  channelId: string;
  channelName: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const setArchived = useServerFn(setPublicChannelArchived);
  const leave = useServerFn(leavePublicChannel);
  const setGeneralHidden = useServerFn(setGeneralChannelHidden);
  const writes: Record<ConfirmedAction, () => Promise<unknown>> = {
    archive: () => setArchived({ data: { channelId, archived: true } }),
    leave: () => leave({ data: { channelId } }),
    "hide-general": () => setGeneralHidden({ data: { hidden: true } }),
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Keeps the last action's copy while the dialog animates closed.
  const lastKind = useRef<ConfirmedAction>("archive");
  if (kind) lastKind.current = kind;
  const copy = CONFIRM_COPY[lastKind.current];

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await writes[lastKind.current]();
      await onDone();
    } catch {
      setError(copy.error());
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay
      isOpen={kind !== null}
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (next || busy) return;
        setError("");
        onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <>
              <DialogHeader title={copy.title()} onClose={busy ? undefined : close} />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {copy.body(channelName)}
              </Text>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={busy} onPress={close}>
                  {m.channel_settings_cancel()}
                </Button>
                <Button
                  color="primary-destructive"
                  isDisabled={busy}
                  isLoading={busy}
                  showTextWhileLoading
                  onPress={() => void confirm()}
                >
                  {busy ? copy.pending() : copy.confirm()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function UnsavedChangesDialog({
  open,
  saving,
  onKeepEditing,
  onDiscard,
  onSaveAndClose,
}: {
  open: boolean;
  saving: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
  onSaveAndClose: () => Promise<void>;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      isDismissable={!saving}
      onOpenChange={(next) => {
        if (!next && !saving) onKeepEditing();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="overflow-hidden text-left">
          <DialogHeader title={m.channel_settings_unsaved_title()} />
          <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
            {m.channel_settings_unsaved_message()}
          </Text>
          <div className="mt-6 flex flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
            <Button color="secondary" isDisabled={saving} onPress={onKeepEditing}>
              {m.channel_settings_keep_editing()}
            </Button>
            <Button color="secondary-destructive" isDisabled={saving} onPress={onDiscard}>
              {m.channel_settings_discard()}
            </Button>
            <Button
              isDisabled={saving}
              isLoading={saving}
              showTextWhileLoading
              onPress={() => void onSaveAndClose()}
            >
              {saving ? m.channel_settings_saving() : m.channel_settings_save_and_close()}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

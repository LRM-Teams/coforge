import { useRef, useState, type FormEvent } from "react";
import {
  Building07 as Building,
  Check,
  ChevronSelectorVertical,
  Plus,
  XClose as X,
} from "@untitledui/icons";
import {
  Button as AriaButton,
  Header as AriaHeader,
  MenuItem as AriaMenuItem,
  Heading,
  Text,
} from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { useAppToast } from "@/components/ui/toast";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
  nameToWorkspaceSlug,
} from "@/server/workspaces/workspace-slug";
import { cx } from "@/utils/cx";

export type WorkspaceOption = { id: string; slug: string; name: string };

export function WorkspaceSwitcher({
  workspaces,
  current,
  onSelect,
  onCreate,
  compact = false,
}: {
  workspaces: WorkspaceOption[];
  current: WorkspaceOption | null;
  onSelect?: (slug: string) => Promise<void> | void;
  onCreate?: (input: { name: string; slug: string }) => Promise<void>;
  /** Icon-only trigger for the collapsed sidebar rail. */
  compact?: boolean;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const toast = useAppToast();
  const label = current?.name ?? m.workspace_unavailable_title();

  async function select(slug: string) {
    try {
      await onSelect?.(slug);
    } catch (error) {
      toast.error(m.workspace_select_error(), error);
    }
  }

  return (
    <>
      <Dropdown.Root>
        {compact ? (
          <AriaButton
            aria-label={`${m.workspace_switcher()}: ${label}`}
            className="flex size-8 items-center justify-center rounded-lg bg-transparent outline-none transition-colors hover:bg-primary_hover focus-visible:ring-2 focus-visible:ring-brand"
          >
            <WorkspaceMark />
          </AriaButton>
        ) : (
          <AriaButton
            aria-label={m.workspace_switcher()}
            className="flex h-12 w-full items-center px-2 text-left outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
          >
            {/* size-5 column matches every sidebar row's icon column, so the
                name below lines up with row text even though the mark itself is 24px. */}
            <span className="mr-2 flex size-5 shrink-0 items-center justify-center">
              <WorkspaceMark />
            </span>
            <span data-workspace-name className="min-w-0 flex-1 truncate text-[13px] font-semibold">
              {label}
            </span>
            <ChevronSelectorVertical aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
          </AriaButton>
        )}
        <Dropdown.Popover
          placement={compact ? "right top" : "bottom start"}
          offset={6}
          className="w-(--trigger-width) min-w-56 rounded-xl p-1.5 shadow-lg"
        >
          <Dropdown.Menu aria-label={m.workspace_switcher()}>
            <Dropdown.Section>
              <AriaHeader className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-tertiary">
                {m.workspace_menu_label()}
              </AriaHeader>
              {workspaces.map((workspace) => (
                <AriaMenuItem
                  key={workspace.id}
                  id={workspace.id}
                  textValue={workspace.name}
                  onAction={() => void select(workspace.slug)}
                  className="group block cursor-pointer px-1.5 py-px outline-hidden"
                >
                  {(state) => (
                    <div
                      className={cx(
                        "relative flex items-center gap-2 rounded-md px-2.5 py-2 outline-focus-ring transition duration-100 ease-linear",
                        "group-hover:bg-primary_hover",
                        state.isFocused && "bg-primary_hover",
                        state.isFocusVisible && "outline-2 -outline-offset-2",
                      )}
                    >
                      <WorkspaceMark />
                      <span className="min-w-0 flex-1 truncate font-medium text-secondary">
                        {workspace.name}
                      </span>
                      {workspace.id === current?.id && (
                        <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                      )}
                    </div>
                  )}
                </AriaMenuItem>
              ))}
            </Dropdown.Section>
            {onCreate && (
              <>
                {workspaces.length > 0 && <Dropdown.Separator />}
                <Dropdown.Item
                  id="create-workspace"
                  icon={Plus}
                  label={m.workspace_create()}
                  onAction={() => setCreateOpen(true)}
                />
              </>
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      {onCreate && (
        <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={onCreate} />
      )}
    </>
  );
}

function WorkspaceMark() {
  return (
    <span
      data-workspace-mark
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center text-brand-secondary"
    >
      <Building className="size-5" />
    </span>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; slug: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const slugTouched = useRef(false);

  const slugError =
    slug.length > 0 && !isValidWorkspaceSlug(slug)
      ? m.workspace_slug_invalid()
      : slug.length > 0 && isReservedWorkspaceSlug(slug)
        ? m.workspace_slug_reserved()
        : "";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !slug.trim() || slugError) return;
    setError("");
    setSubmitting(true);
    try {
      await onCreate({ name: name.trim(), slug: slug.trim() });
      close();
    } catch (cause) {
      if (isAppError(cause) && cause.code === "CONFLICT") setError(m.workspace_slug_taken());
      else if (isAppError(cause) && cause.code === "INVALID_INPUT")
        setError(m.workspace_slug_invalid());
      else setError(m.workspace_create_error());
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    setName("");
    setSlug("");
    setError("");
    slugTouched.current = false;
    onOpenChange(false);
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <Modal className="w-[min(480px,calc(100vw-2rem))]">
        <Dialog>
          <form onSubmit={submit}>
            <div className="flex items-start justify-between gap-6 px-6 pt-6">
              <div>
                <Heading slot="title" className="text-base font-semibold text-primary">
                  {m.workspace_create_title()}
                </Heading>
                <Text slot="description" className="mt-2 text-sm text-tertiary">
                  {m.workspace_create_description()}
                </Text>
              </div>
              <ButtonUtility
                aria-label={m.controls_close()}
                icon={X}
                size="sm"
                color="tertiary"
                onClick={close}
              />
            </div>
            <div className="grid gap-4 px-6 py-6">
              <label htmlFor="workspace-create-name" className="grid gap-1.5 text-sm">
                {m.workspace_name_label()}
                <input
                  id="workspace-create-name"
                  name="name"
                  required
                  value={name}
                  placeholder={m.workspace_name_placeholder()}
                  onChange={(event) => {
                    const value = event.target.value;
                    setName(value);
                    if (!slugTouched.current) setSlug(nameToWorkspaceSlug(value));
                  }}
                  className="h-9 rounded-md border border-secondary bg-primary px-3 outline-none focus:ring-2 focus:ring-brand/30"
                />
              </label>
              <label htmlFor="workspace-create-slug" className="grid gap-1.5 text-sm">
                {m.workspace_slug_label()}
                <input
                  id="workspace-create-slug"
                  name="slug"
                  required
                  value={slug}
                  placeholder={m.workspace_slug_placeholder()}
                  onChange={(event) => {
                    slugTouched.current = true;
                    setSlug(event.target.value);
                  }}
                  className="h-9 rounded-md border border-secondary bg-primary px-3 outline-none focus:ring-2 focus:ring-brand/30"
                />
              </label>
              {(slugError || error) && (
                <p role="alert" className="text-sm text-error-primary">
                  {error || slugError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-secondary px-6 py-4">
              <Button type="button" color="secondary" onPress={close}>
                {m.controls_cancel()}
              </Button>
              <Button
                type="submit"
                isDisabled={Boolean(slugError)}
                isLoading={submitting}
                showTextWhileLoading
              >
                {submitting ? m.workspace_create_submitting() : m.workspace_create_submit()}
              </Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

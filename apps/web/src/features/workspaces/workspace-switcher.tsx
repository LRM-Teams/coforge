import { useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAppToast } from "@/components/ui/toast";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
  nameToWorkspaceSlug,
} from "@/server/workspaces/workspace-slug";

export type WorkspaceOption = { id: string; slug: string; name: string };

export function WorkspaceSwitcher({
  workspaces,
  current,
  onSelect,
  onCreate,
}: {
  workspaces: WorkspaceOption[];
  current: WorkspaceOption | null;
  onSelect?: (slug: string) => Promise<void> | void;
  onCreate?: (input: { name: string; slug: string }) => Promise<void>;
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
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          aria-label={m.workspace_switcher()}
          className="flex h-10 w-full items-center gap-2 rounded-lg border bg-background px-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <WorkspaceMark name={label} />
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-(--anchor-width) min-w-56 rounded-xl p-1.5 shadow-lg"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>{m.workspace_menu_label()}</DropdownMenuLabel>
            {workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                className="h-9 gap-2 px-2"
                onClick={() => void select(workspace.slug)}
              >
                <WorkspaceMark name={workspace.name} />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {workspace.id === current?.id && (
                  <Check aria-hidden="true" className="size-3.5 text-foreground" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          {onCreate && (
            <>
              {workspaces.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem className="h-9 gap-2 px-2" onClick={() => setCreateOpen(true)}>
                <Plus aria-hidden="true" className="size-3.5" />
                {m.workspace_create()}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onCreate && (
        <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={onCreate} />
      )}
    </>
  );
}

function WorkspaceMark({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "W";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-950 text-[11px] font-medium text-white",
      )}
    >
      {initial}
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="w-[min(480px,calc(100vw-2rem))]">
          <form onSubmit={submit}>
            <div className="flex items-start justify-between gap-6 px-6 pt-6">
              <div>
                <DialogTitle>{m.workspace_create_title()}</DialogTitle>
                <DialogDescription className="mt-2">
                  {m.workspace_create_description()}
                </DialogDescription>
              </div>
              <DialogClose
                render={
                  <Button type="button" variant="ghost" size="icon" aria-label={m.controls_close()}>
                    <X aria-hidden="true" />
                  </Button>
                }
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
                  className="h-9 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
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
                  className="h-9 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                />
              </label>
              {(slugError || error) && (
                <p role="alert" className="text-sm text-destructive-text">
                  {error || slugError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t px-6 py-4">
              <Button type="button" variant="outline" onClick={close}>
                {m.controls_cancel()}
              </Button>
              <Button type="submit" disabled={submitting || Boolean(slugError)}>
                {submitting ? m.workspace_create_submitting() : m.workspace_create_submit()}
              </Button>
            </div>
          </form>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

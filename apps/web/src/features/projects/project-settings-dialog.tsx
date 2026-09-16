import { useEffect, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Heading } from "react-aria-components";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { listAccessibleGitHubRepositories } from "@/features/integrations/github.functions";
import { m } from "@/paraglide/messages";
import { deleteProject, updateProject, type getProject } from "./projects.functions";

export function ProjectSettingsDialog({
  project,
  onClose,
}: {
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
  onClose: () => void;
}) {
  const router = useRouter();
  const save = useServerFn(updateProject);
  const remove = useServerFn(deleteProject);
  const repositories = useServerFn(listAccessibleGitHubRepositories);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [selection, setSelection] = useState("keep");
  const [items, setItems] = useState<Awaited<ReturnType<typeof listAccessibleGitHubRepositories>>>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [repositoryError, setRepositoryError] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    let cancelled = false;
    repositories()
      .then((available) => {
        if (!cancelled) setItems(available);
      })
      .catch(() => {
        if (!cancelled) setRepositoryError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repositories]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (deleting) {
        await remove({ data: { id: project.id, confirmation } });
        await router.navigate({ to: "/projects" });
        await router.invalidate({ sync: true });
      } else {
        const repository = items.find((item) => String(item.id) === selection);
        await save({
          data: {
            id: project.id,
            name,
            description,
            ...(selection === "none"
              ? { repository: null }
              : repository
                ? {
                    repository: {
                      id: repository.id,
                      installationId: repository.installationId,
                      fullName: repository.fullName,
                    },
                  }
                : {}),
          },
        });
        await router.invalidate({ sync: true });
      }
      onClose();
    } catch {
      setError(deleting ? m.project_delete_error() : m.project_settings_error());
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal className="w-[min(480px,calc(100vw-2rem))]">
        <Dialog>
          <form
            onSubmit={submit}
            className="grid max-h-[calc(100dvh-4rem)] gap-4 overflow-y-auto p-6"
          >
            <Heading slot="title" className="text-lg font-semibold">
              {deleting ? m.project_delete() : m.project_settings()}
            </Heading>
            {deleting ? (
              <>
                <p className="text-sm text-tertiary">{m.project_delete_warning()}</p>
                <label className="grid gap-1 text-sm font-medium">
                  {m.project_delete_confirm({ name: project.name })}
                  <input
                    autoFocus
                    required
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    disabled={busy}
                    className="h-10 rounded-md border border-secondary bg-primary px-3"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="grid gap-1 text-sm font-medium">
                  {m.project_name()}
                  <input
                    required
                    maxLength={100}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={busy}
                    className="h-10 rounded-md border border-secondary bg-primary px-3"
                  />
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  {m.project_description()}
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    disabled={busy}
                    className="resize-y rounded-md border border-secondary bg-primary px-3 py-2"
                  />
                </label>
                <Select
                  label={m.project_repository()}
                  selectedKey={selection}
                  isDisabled={busy}
                  onSelectionChange={(key) => {
                    if (key) setSelection(String(key));
                  }}
                >
                  <Select.Item
                    id="keep"
                    label={project.githubFullName ?? m.project_no_repository()}
                  />
                  {project.githubFullName && (
                    <Select.Item id="none" label={m.project_repository_disconnect()} />
                  )}
                  {items.map((item) => (
                    <Select.Item key={item.id} id={String(item.id)} label={item.fullName} />
                  ))}
                </Select>
                {loading && (
                  <p role="status" className="text-sm text-tertiary">
                    {m.project_repository_loading()}
                  </p>
                )}
                {repositoryError && (
                  <p role="status" className="text-sm text-tertiary">
                    {m.project_repository_unavailable()}
                  </p>
                )}
                <Link
                  to="/settings"
                  search={{ section: "integrations" }}
                  className="text-sm font-medium text-brand-secondary hover:underline"
                >
                  {m.project_github_settings()}
                </Link>
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-error-primary">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                color="secondary"
                isDisabled={busy}
                onPress={() => {
                  if (deleting) {
                    setDeleting(false);
                    setConfirmation("");
                    setError("");
                  } else onClose();
                }}
              >
                {m.controls_cancel()}
              </Button>
              <Button
                type="submit"
                color={deleting ? "primary-destructive" : "primary"}
                isLoading={busy}
                isDisabled={deleting ? confirmation !== project.name : !name.trim()}
                showTextWhileLoading
              >
                {deleting ? m.project_delete() : m.project_save()}
              </Button>
            </div>
            {!deleting && (
              <div className="border-t border-secondary pt-4">
                <Button
                  color="secondary-destructive"
                  isDisabled={busy}
                  onPress={() => {
                    setDeleting(true);
                    setError("");
                  }}
                >
                  {m.project_delete()}
                </Button>
              </div>
            )}
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

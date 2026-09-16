import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Share04 } from "@untitledui/icons";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import {
  getGitHubConnection,
  listAccessibleGitHubRepositories,
} from "@/features/integrations/github.functions";
import { m } from "@/paraglide/messages";
import { createProject } from "./projects.functions";

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const repositories = useServerFn(listAccessibleGitHubRepositories);
  const githubConnection = useServerFn(getGitHubConnection);
  const create = useServerFn(createProject);
  const [items, setItems] = useState<Awaited<ReturnType<typeof listAccessibleGitHubRepositories>>>(
    [],
  );
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [repositoryId, setRepositoryId] = useState(0);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError("");
    setItems([]);
    setInstallUrl(null);
    githubConnection()
      .then((connection) => {
        if (!cancelled) setInstallUrl(connection.installUrl);
      })
      .catch(() => {});
    repositories()
      .then((available) => {
        if (cancelled) return;
        setItems(available);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [githubConnection, open, repositories]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const repo = items.find((item) => item.id === repositoryId);
    setBusy(true);
    setError("");
    try {
      await create({
        data: repo
          ? {
              name,
              slug,
              installationId: repo.installationId,
              repositoryId: repo.id,
              fullName: repo.fullName,
            }
          : { name, slug },
      });
      await onCreated();
      onOpenChange(false);
    } catch {
      setError("Could not create this project. Check the name, slug, and repository access.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange}>
      <Modal className="w-[min(480px,calc(100vw-2rem))]">
        <Dialog>
          <form onSubmit={submit} className="grid gap-4 p-6">
            <h2 className="text-lg font-semibold">Create project</h2>
            <p className="text-sm text-tertiary">
              Optionally connect a GitHub repository to this Workspace.
            </p>
            <label className="grid gap-1">
              Name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 rounded-md border border-secondary bg-primary px-3"
              />
            </label>
            <label className="grid gap-1">
              Slug
              <input
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="h-9 rounded-md border border-secondary bg-primary px-3"
              />
            </label>
            <Select
              label="GitHub repository"
              placeholder={
                items.length ? "No repository (start from scratch)" : "No accessible repositories"
              }
              selectedKey={repositoryId ? String(repositoryId) : null}
              onSelectionChange={(key) => setRepositoryId(key && key !== "none" ? Number(key) : 0)}
            >
              <Select.Item id="none" label="No repository (start from scratch)" />
              {items.map((item) => (
                <Select.Item key={item.id} id={String(item.id)} label={item.fullName} />
              ))}
            </Select>
            <p className="text-sm text-tertiary">
              {m.github_repository_missing()}{" "}
              {installUrl ? (
                <a
                  href={installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-secondary underline underline-offset-4 hover:text-primary"
                >
                  {m.github_manage_repository_access()}
                  <Share04 aria-hidden="true" className="size-4" />
                </a>
              ) : (
                <span className="inline-flex items-center gap-1 font-medium text-secondary">
                  {m.github_manage_repository_access()}
                  <Share04 aria-hidden="true" className="size-4" />
                </span>
              )}
            </p>
            {error && (
              <p role="alert" className="text-sm text-error-primary">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" color="secondary" onPress={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" isLoading={busy} showTextWhileLoading>
                Create project
              </Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

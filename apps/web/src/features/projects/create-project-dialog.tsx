import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import {
  listGitHubInstallations,
  listGitHubRepositories,
} from "@/features/integrations/github.functions";
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
  const installations = useServerFn(listGitHubInstallations);
  const repositories = useServerFn(listGitHubRepositories);
  const create = useServerFn(createProject);
  const [items, setItems] = useState<
    Awaited<ReturnType<typeof listGitHubRepositories>>["repositories"]
  >([]);
  const [installationId, setInstallationId] = useState(0);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [repositoryId, setRepositoryId] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open)
      installations({ data: { page: 1 } })
        .then(async (result) => {
          const first = result.installations[0]?.id;
          if (first) {
            setInstallationId(first);
            setItems(
              (await repositories({ data: { installationId: first, page: 1 } })).repositories,
            );
          }
        })
        .catch(() => setError("GitHub is disconnected or unavailable."));
  }, [open, installations, repositories]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const repo = items.find((item) => item.id === repositoryId);
    if (!repo) return;
    setBusy(true);
    setError("");
    try {
      await create({ data: { name, slug, installationId, repositoryId, fullName: repo.fullName } });
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
            <p className="text-sm text-tertiary">Connect a GitHub repository to this Workspace.</p>
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
            <label className="grid gap-1">
              GitHub repository
              <Select
                label="GitHub repository"
                placeholder={items.length ? "Select a repository" : "No accessible repositories"}
                selectedKey={repositoryId ? String(repositoryId) : null}
                onSelectionChange={(key) => setRepositoryId(Number(key))}
                isRequired
              >
                {items.map((item) => (
                  <Select.Item key={item.id} id={String(item.id)} label={item.fullName} />
                ))}
              </Select>
            </label>
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

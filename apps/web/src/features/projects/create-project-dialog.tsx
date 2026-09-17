import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Share04 } from "@untitledui/icons";
import { Heading } from "react-aria-components";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import {
  getGitHubConnection,
  listAccessibleGitHubRepositories,
} from "@/features/integrations/github.functions";
import { nameToSlug } from "@/lib/slug";
import { m } from "@/paraglide/messages";
import { createProject } from "./projects.functions";
import { isValidProjectSlug, PROJECT_SLUG_MAX_LENGTH } from "./projects.schemas";

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
  // The slug follows the name until the slug field is edited by hand; clearing
  // it makes it follow the name again. The name follows a selected GitHub
  // repository's short name only until the user types into the name field.
  const slugTouched = useRef(false);
  const nameTouched = useRef(false);

  const slugError = slug.length > 0 && !isValidProjectSlug(slug) ? m.project_slug_invalid() : "";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError("");
    setItems([]);
    setInstallUrl(null);
    setName("");
    setSlug("");
    setRepositoryId(0);
    nameTouched.current = false;
    slugTouched.current = false;
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
        if (!cancelled) setError(m.project_repository_unavailable());
      });
    return () => {
      cancelled = true;
    };
  }, [githubConnection, open, repositories]);

  function changeName(value: string) {
    setName(value);
    nameTouched.current = true;
    if (!slugTouched.current) setSlug(nameToSlug(value, PROJECT_SLUG_MAX_LENGTH));
  }

  function changeSlug(value: string) {
    if (value.length === 0) {
      // Clearing the slug hands control back to the name.
      slugTouched.current = false;
      setSlug(nameToSlug(name, PROJECT_SLUG_MAX_LENGTH));
      return;
    }
    slugTouched.current = true;
    setSlug(value);
  }

  function selectRepository(id: number) {
    setRepositoryId(id);
    if (!id || nameTouched.current) return;
    const repo = items.find((item) => item.id === id);
    if (!repo) return;
    const shortName = repo.fullName.split("/").pop() || repo.fullName;
    setName(shortName);
    if (!slugTouched.current) setSlug(nameToSlug(shortName, PROJECT_SLUG_MAX_LENGTH));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !slug.trim() || slugError) return;
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
      setError(m.project_create_error());
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange}>
      <Modal className="w-[min(480px,calc(100vw-2rem))]">
        <Dialog>
          <form onSubmit={submit} className="grid gap-4 p-6">
            <Heading slot="title" className="text-lg font-semibold">
              {m.project_create()}
            </Heading>
            <p className="text-sm text-tertiary">{m.project_repository_optional()}</p>
            <label className="grid gap-1">
              {m.project_name()}
              <input
                required
                value={name}
                onChange={(e) => changeName(e.target.value)}
                className="h-9 rounded-md border border-secondary bg-primary px-3"
              />
            </label>
            <label className="grid gap-1">
              {m.project_slug()}
              <input
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={PROJECT_SLUG_MAX_LENGTH}
                value={slug}
                onChange={(e) => changeSlug(e.target.value)}
                aria-invalid={slugError ? true : undefined}
                className="h-9 rounded-md border border-secondary bg-primary px-3"
              />
              {slugError && (
                <p role="alert" className="text-sm text-error-primary">
                  {slugError}
                </p>
              )}
            </label>
            <Select
              label={m.project_repository()}
              placeholder={
                items.length ? m.project_repository_none() : m.project_repository_empty()
              }
              selectedKey={repositoryId ? String(repositoryId) : null}
              onSelectionChange={(key) => selectRepository(key && key !== "none" ? Number(key) : 0)}
            >
              <Select.Item id="none" label={m.project_repository_none()} />
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
                {m.controls_cancel()}
              </Button>
              <Button
                type="submit"
                isDisabled={Boolean(slugError)}
                isLoading={busy}
                showTextWhileLoading
              >
                {m.project_create()}
              </Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

import { useEffect, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "@untitledui/icons";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { listAccessibleGitHubRepositories } from "@/features/integrations/github.functions";
import { m } from "@/paraglide/messages";
import {
  deleteProject,
  updateProject,
  uploadProjectIcon,
  type getProject,
} from "./projects.functions";
import { ProjectImage } from "./project-image";

export function ProjectSettingsPage({
  project,
}: {
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
}) {
  const router = useRouter();
  const save = useServerFn(updateProject);
  const remove = useServerFn(deleteProject);
  const upload = useServerFn(uploadProjectIcon);
  const repositories = useServerFn(listAccessibleGitHubRepositories);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [imageMessage, setImageMessage] = useState("");
  const [saved, setSaved] = useState(false);
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

  async function changeImage(file: File) {
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    setImageMessage(m.project_image_uploading());
    try {
      const data = new FormData();
      data.set("id", project.id);
      data.set("file", file);
      await upload({ data });
      await router.invalidate({ sync: true });
      setImageMessage(m.project_image_saved());
    } catch {
      setImageMessage("");
      setError(m.project_image_error());
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
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
        setSelection("keep");
        setName(name.trim());
        setDescription(description.trim());
        setSaved(true);
      }
    } catch {
      setError(deleting ? m.project_delete_error() : m.project_settings_error());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader
        heading={m.project_settings()}
        leading={
          <Link
            to="/projects/$projectSlug"
            params={{ projectSlug: project.slug }}
            aria-label={project.name}
            className="shrink-0 rounded-lg p-2 text-tertiary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
          </Link>
        }
        meta={
          <span className="hidden truncate text-sm text-tertiary sm:block">{project.name}</span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
        <form
          onSubmit={submit}
          onChange={() => setSaved(false)}
          className="mx-auto grid w-full max-w-xl gap-6"
        >
          {deleting ? (
            <>
              <h2 className="text-lg font-semibold">{m.project_delete()}</h2>
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
              <div className="flex items-center gap-4">
                <label className="cursor-pointer rounded-xl outline-focus-ring focus-within:outline-2 focus-within:outline-offset-4">
                  <ProjectImage
                    name={project.name}
                    url={project.iconUrl}
                    className="size-16 text-2xl"
                  />
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label={m.project_image_upload()}
                    disabled={busy}
                    className="sr-only"
                    onChange={async (event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) await changeImage(file);
                    }}
                  />
                </label>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{m.project_image_upload()}</p>
                  <p className="text-sm text-tertiary">{m.project_image_hint()}</p>
                  {imageMessage && (
                    <p role="status" className="text-sm text-tertiary">
                      {imageMessage}
                    </p>
                  )}
                </div>
              </div>
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
                  if (key) {
                    setSelection(String(key));
                    setSaved(false);
                  }
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
              {!loading && (repositoryError || items.length === 0) && (
                <Link
                  to="/settings"
                  search={{ section: "integrations" }}
                  className="text-sm font-medium text-brand-secondary hover:underline"
                >
                  {m.project_github_settings()}
                </Link>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-error-primary">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-3">
            {saved && (
              <p role="status" className="mr-auto text-sm text-tertiary">
                {m.project_saved()}
              </p>
            )}
            {deleting && (
              <Button
                color="secondary"
                isDisabled={busy}
                onPress={() => {
                  setDeleting(false);
                  setConfirmation("");
                  setError("");
                }}
              >
                {m.controls_cancel()}
              </Button>
            )}
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
                color="tertiary-destructive"
                isDisabled={busy}
                onPress={() => {
                  setDeleting(true);
                  setSaved(false);
                  setError("");
                }}
              >
                {m.project_delete()}
              </Button>
            </div>
          )}
        </form>
      </div>
    </main>
  );
}

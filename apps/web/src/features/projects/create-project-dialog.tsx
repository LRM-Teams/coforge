import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRight, FolderLock, GitBranch01, Share04 } from "@untitledui/icons";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { ComboBox } from "#src/components/base/select/combobox";
import { SelectItem } from "#src/components/base/select/select-item";
import {
  getGitHubConnection,
  listAccessibleGitHubRepositories,
} from "#src/features/integrations/github.functions";
import { isAppError } from "#src/lib/app-error";
import { nameToSlug } from "#src/lib/slug";
import { m } from "#src/paraglide/messages";
import { parseGitHubRepositoryInput } from "./github-repository-input";
import { createProject } from "./projects.functions";
import { isValidProjectSlug, PROJECT_SLUG_MAX_LENGTH } from "./projects.schemas";

type Source = "scratch" | "github";
type GitHubConnection = Awaited<ReturnType<typeof getGitHubConnection>>;
type AccessibleRepository = Awaited<ReturnType<typeof listAccessibleGitHubRepositories>>[number];

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
  const [step, setStep] = useState<"choose" | "form">("choose");
  const [source, setSource] = useState<Source>("scratch");
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [items, setItems] = useState<AccessibleRepository[]>([]);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [repositoryId, setRepositoryId] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The slug follows the name until the slug field is edited by hand; clearing
  // it makes it follow the name again. The name follows a selected GitHub
  // repository's short name only until the user types into the name field.
  const slugTouched = useRef(false);
  const nameTouched = useRef(false);

  const slugError = slug.length > 0 && !isValidProjectSlug(slug) ? m.project_slug_invalid() : "";
  const needsRepository = source === "github";
  const githubConnected = connection?.status === "connected";
  const selectedRepository = items.find((item) => item.id === repositoryId);
  const parsedRepository = parseGitHubRepositoryInput(repositoryQuery);
  const canSubmit =
    name.trim().length > 0 &&
    slug.trim().length > 0 &&
    !slugError &&
    (!needsRepository || Boolean(selectedRepository || parsedRepository));

  useEffect(() => {
    if (!open) return;
    setStep("choose");
    setSource("scratch");
    setError("");
    setConnection(null);
    setItems([]);
    setName("");
    setSlug("");
    setRepositoryQuery("");
    setRepositoryId(0);
    setBusy(false);
    nameTouched.current = false;
    slugTouched.current = false;
  }, [open]);

  useEffect(() => {
    if (!open || step !== "form" || source !== "github") return;
    let cancelled = false;
    setError("");
    setConnection(null);
    setItems([]);
    githubConnection()
      .then(async (next) => {
        if (cancelled) return;
        setConnection(next);
        if (next.status !== "connected") return;
        try {
          const available = await repositories();
          if (!cancelled) setItems(available);
        } catch {
          if (!cancelled) setError(m.project_repository_unavailable());
        }
      })
      .catch(() => {
        if (!cancelled) setError(m.project_repository_unavailable());
      });
    return () => {
      cancelled = true;
    };
  }, [githubConnection, open, repositories, source, step]);

  function resetForm() {
    setError("");
    setConnection(null);
    setItems([]);
    setName("");
    setSlug("");
    setRepositoryQuery("");
    setRepositoryId(0);
    nameTouched.current = false;
    slugTouched.current = false;
  }

  function chooseSource(next: Source) {
    setSource(next);
    resetForm();
    setStep("form");
  }

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

  function applyRepositoryName(fullName: string) {
    if (nameTouched.current) return;
    const shortName = fullName.split("/").pop() || fullName;
    setName(shortName);
    if (!slugTouched.current) setSlug(nameToSlug(shortName, PROJECT_SLUG_MAX_LENGTH));
  }

  function applyRepositoryQuery(value: string) {
    setRepositoryQuery(value);
    const parsed = parseGitHubRepositoryInput(value);
    const match = parsed
      ? items.find((item) => item.fullName.toLowerCase() === parsed.fullName.toLowerCase())
      : undefined;
    setRepositoryId(match?.id ?? 0);
    if (parsed) applyRepositoryName(parsed.fullName);
  }

  function selectRepository(id: number) {
    const repo = items.find((item) => item.id === id);
    if (!repo) {
      setRepositoryId(0);
      return;
    }
    setRepositoryId(repo.id);
    setRepositoryQuery(repo.fullName);
    applyRepositoryName(repo.fullName);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) {
      if (needsRepository && !selectedRepository && !parsedRepository) {
        setError(
          connection && !githubConnected
            ? m.project_repository_not_connected()
            : m.project_create_error(),
        );
      }
      return;
    }
    const repo = selectedRepository;
    const publicName = parsedRepository?.fullName;
    if (needsRepository && !repo && !publicName) return;
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
          : publicName
            ? { name, slug, fullName: publicName }
            : { name, slug },
      });
      await onCreated();
      onOpenChange(false);
    } catch (cause) {
      setError(
        isAppError(cause) && cause.code === "CONFLICT"
          ? m.project_slug_taken()
          : isAppError(cause) && cause.code === "ACCESS_DENIED"
            ? m.project_repository_needs_access()
            : m.project_create_error(),
      );
    } finally {
      setBusy(false);
    }
  }

  const repositoryHint =
    needsRepository && connection && !githubConnected
      ? m.project_repository_not_connected()
      : undefined;

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <Modal className="w-[min(480px,calc(100vw-2rem))]">
        <Dialog>
          {() => (
            <>
              <DialogHeader
                title={m.project_create_title()}
                description={step === "choose" ? m.project_create_source_description() : undefined}
                onClose={busy ? undefined : () => onOpenChange(false)}
              />
              {step === "choose" ? (
                <>
                  <div className="grid gap-3 px-6 py-6">
                    <SourceOption
                      icon={FolderLock}
                      label={m.project_create_from_scratch()}
                      description={m.project_create_from_scratch_description()}
                      onSelect={() => chooseSource("scratch")}
                    />
                    <SourceOption
                      icon={GitBranch01}
                      label={m.project_create_from_github()}
                      description={m.project_create_from_github_description()}
                      onSelect={() => chooseSource("github")}
                    />
                  </div>
                  <div className="flex items-center justify-end border-t border-secondary px-6 py-4">
                    <Button type="button" color="secondary" onPress={() => onOpenChange(false)}>
                      {m.controls_cancel()}
                    </Button>
                  </div>
                </>
              ) : (
                <form onSubmit={submit}>
                  <div className="grid gap-4 px-6 py-6">
                    <Input label={m.project_name()} isRequired value={name} onChange={changeName} />
                    <div className="grid gap-1.5">
                      <Input
                        label={m.project_slug()}
                        isRequired
                        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                        maxLength={PROJECT_SLUG_MAX_LENGTH}
                        value={slug}
                        onChange={changeSlug}
                        isInvalid={Boolean(slugError)}
                      />
                      {slugError && (
                        <p role="alert" className="text-sm text-error-primary">
                          {slugError}
                        </p>
                      )}
                    </div>
                    {needsRepository && (
                      <>
                        <ComboBox
                          label={m.project_repository()}
                          placeholder={m.project_repository_url_placeholder()}
                          shortcut={false}
                          allowsCustomValue
                          items={items.map((item) => ({
                            id: String(item.id),
                            label: item.fullName,
                          }))}
                          selectedKey={repositoryId ? String(repositoryId) : null}
                          inputValue={repositoryQuery}
                          onInputChange={applyRepositoryQuery}
                          onSelectionChange={(key) => {
                            if (key) selectRepository(Number(key));
                          }}
                        >
                          {(item) => <SelectItem id={item.id} label={item.label} />}
                        </ComboBox>
                        <p className="text-sm text-tertiary">
                          {repositoryHint ? `${repositoryHint} ` : null}
                          {githubConnected ? (
                            <>
                              {m.github_repository_missing()}{" "}
                              {connection.installUrl ? (
                                <a
                                  href={connection.installUrl}
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
                            </>
                          ) : (
                            <Link
                              to="/settings"
                              search={{ section: "integrations" }}
                              className="font-medium text-brand-secondary underline underline-offset-4 hover:text-primary"
                            >
                              {m.github_connect()}
                            </Link>
                          )}
                        </p>
                      </>
                    )}
                    {error && (
                      <p role="alert" className="text-sm text-error-primary">
                        {error}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-2 border-t border-secondary px-6 py-4">
                    <Button
                      type="button"
                      color="secondary"
                      onPress={() => setStep("choose")}
                      isDisabled={busy}
                    >
                      {m.controls_back()}
                    </Button>
                    <Button
                      type="submit"
                      isDisabled={!canSubmit}
                      isLoading={busy}
                      showTextWhileLoading
                    >
                      {m.project_create()}
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function SourceOption({
  icon: Icon,
  label,
  description,
  onSelect,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement> & { color?: string; size?: number }>;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      color="secondary"
      noTextPadding
      iconTrailing={ChevronRight}
      className="h-auto w-full justify-between gap-3 rounded-xl px-4 py-3 text-left *:data-text:min-w-0 *:data-text:flex-1"
      onPress={onSelect}
    >
      <span className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-secondary bg-primary text-tertiary shadow-xs">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <span className="min-w-0 whitespace-normal">
          <span className="block text-sm font-semibold text-primary">{label}</span>
          <span className="mt-0.5 block text-sm font-normal text-tertiary">{description}</span>
        </span>
      </span>
    </Button>
  );
}

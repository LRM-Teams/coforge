import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import githubMark from "@lobehub/icons-static-svg/icons/github.svg";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Tooltip } from "@/components/base/tooltip/tooltip";
import { AlertCircle as Info } from "@untitledui/icons";
import { m } from "@/paraglide/messages";
import {
  disconnectGitHub,
  getGitHubConnection,
  startGitHubConnection,
  startGitHubReauthorization,
  listGitHubInstallations,
  listGitHubRepositories,
} from "./github.functions";

export function GitHubSettings({
  callbackError,
  wrongAccount,
}: {
  callbackError: boolean;
  wrongAccount: boolean;
}) {
  const [connection, setConnection] = useState<Awaited<ReturnType<typeof getGitHubConnection>>>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = useServerFn(getGitHubConnection);
  const connect = useServerFn(startGitHubConnection);
  const reauthorize = useServerFn(startGitHubReauthorization);
  const disconnect = useServerFn(disconnectGitHub);
  const listInstallations = useServerFn(listGitHubInstallations);
  const listRepositories = useServerFn(listGitHubRepositories);
  const [installations, setInstallations] = useState<Awaited<
    ReturnType<typeof listGitHubInstallations>
  > | null>(null);
  const [repositories, setRepositories] = useState<Record<number, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    setConnection(undefined);
    setInstallations(null);
    setRepositories({});
    setError(false);
    load()
      .then((value) => {
        if (!cancelled) setConnection(value);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [load, revision]);

  async function authorize() {
    setBusy(true);
    setError(false);
    try {
      window.location.assign((await connect()).url);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function showInstallations() {
    setBusy(true);
    try {
      setInstallations(await listInstallations({ data: { page: 1 } }));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function showRepositories(installationId: number) {
    if (repositories[installationId]) {
      setRepositories((current) => {
        const next = { ...current };
        delete next[installationId];
        return next;
      });
      return;
    }
    setBusy(true);
    try {
      const result = await listRepositories({ data: { installationId, page: 1 } });
      setRepositories((current) => ({
        ...current,
        [installationId]: result.repositories.map((repository) => repository.fullName),
      }));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function restoreAuthorization() {
    setBusy(true);
    setError(false);
    try {
      window.location.assign((await reauthorize()).url);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection() {
    setBusy(true);
    setError(false);
    try {
      await disconnect();
      setRevision((value) => value + 1);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 px-4 py-6 text-sm sm:px-8">
      <section
        aria-label="GitHub"
        className="flex flex-col gap-4 rounded-xl border border-secondary bg-primary p-4 sm:p-5 xl:flex-row xl:items-center xl:justify-between"
      >
        <div className="flex min-w-0 items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <img src={githubMark} alt="" className="size-7 dark:invert" />
          </div>
          <div className="min-w-0 space-y-1">
            <h2 className="break-words text-md font-semibold text-primary">
              {connection?.login ? `@${connection.login} on GitHub` : "GitHub"}
            </h2>
            <p className="text-tertiary">
              {connection?.login ? m.github_disconnect_help() : m.github_description()}
            </p>
            {!connection && !error && (
              <p role="status" className="text-tertiary">
                {m.settings_loading()}
              </p>
            )}
            {connection?.status === "unconfigured" && (
              <p role="status" className="text-tertiary">
                {m.github_unconfigured()}
              </p>
            )}
            {connection?.status === "pending_installation" && (
              <p role="status" className="text-tertiary">
                {m.github_pending_installation()}
              </p>
            )}
            {connection?.status === "reauthorize" && (
              <p role="status" className="text-tertiary">
                {m.github_expired()}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {connection &&
            connection.status !== "unconfigured" &&
            connection.status !== "pending_installation" && (
              <Button
                size="sm"
                color={connection.status === "connected" ? "secondary" : "primary"}
                isDisabled={busy}
                onPress={connection.status === "reauthorize" ? restoreAuthorization : authorize}
              >
                {connection.status === "connected"
                  ? m.github_replace()
                  : connection.status === "reauthorize"
                    ? m.github_reauthorize()
                    : m.github_connect()}
              </Button>
            )}
          {connection?.login && connection.installUrl && (
            <>
              <Tooltip title="查看 GitHub App 安装在哪些账号、组织和仓库" placement="top">
                <ButtonUtility
                  aria-label="查看 GitHub App 安装信息"
                  icon={Info}
                  size="sm"
                  color="tertiary"
                  isDisabled={busy}
                  onClick={showInstallations}
                />
              </Tooltip>
              <Button
                size="sm"
                color="secondary"
                href={connection.installUrl}
                target="_blank"
                rel="noopener noreferrer"
                isDisabled={busy}
              >
                {m.github_configure()}
              </Button>
              <Button size="sm" color="secondary" isDisabled={busy} onPress={removeConnection}>
                {m.github_disconnect()}
              </Button>
            </>
          )}
          {error && (
            <Button
              size="sm"
              color="secondary"
              isDisabled={busy}
              onPress={() => setRevision((value) => value + 1)}
            >
              {m.github_refresh()}
            </Button>
          )}
        </div>
      </section>
      {installations && (
        <section
          className="rounded-xl border border-secondary bg-primary p-4 sm:p-5"
          aria-label="GitHub App 安装信息"
        >
          <h3 className="font-semibold text-primary">GitHub App 安装信息</h3>
          {installations.installations.length === 0 ? (
            <p className="mt-2 text-tertiary">当前账号尚未安装 CoForge App。</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {installations.installations.map((installation) => (
                <li key={installation.id} className="rounded-lg border border-secondary p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-primary">{installation.login}</span>
                    <span className="text-tertiary">
                      {installation.suspended
                        ? "已暂停"
                        : installation.repositorySelection === "all"
                          ? "全部仓库"
                          : "指定仓库"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-tertiary">
                    安装类型：
                    {installation.repositorySelection === "all" ? "全部仓库" : "仅选定仓库"}
                  </p>
                  {installation.repositorySelection === "selected" && (
                    <Button
                      size="sm"
                      color="secondary"
                      className="mt-3"
                      isDisabled={busy}
                      onPress={() => showRepositories(installation.id)}
                    >
                      {repositories[installation.id] ? "收起仓库范围" : "查看仓库范围"}
                    </Button>
                  )}
                  {repositories[installation.id] && (
                    <ul className="mt-2 list-disc pl-5 text-xs text-tertiary">
                      {repositories[installation.id].map((repository) => (
                        <li key={repository}>{repository}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {callbackError && (
        <p role="alert" className="text-error-primary">
          {wrongAccount ? m.github_wrong_account() : m.github_callback_error()}
        </p>
      )}
      {error && (
        <p role="alert" className="text-error-primary">
          {m.github_error()}
        </p>
      )}
    </div>
  );
}

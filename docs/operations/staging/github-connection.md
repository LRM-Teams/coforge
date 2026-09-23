# Personal GitHub connection

The staging App ID is `4937758`, Client ID is `Iv23lip3Ca7BRl50L2O4`, and its
authorization callback must be
`https://staging.coforge.cn/api/integrations/github/callback`.
Keep expiring user access tokens enabled. Repository discovery requires Metadata
(read). Agent HTTPS Git and the planned GitHub operations require repository
permissions Actions (read), Checks (read), Contents (write), Pull requests
(write), Commit statuses (read), and Workflows (write); no organization-member or
email permission is needed. Installation and personal authorization are separate
actions. Existing installations must approve changed permissions and select the
repositories Agents may use.
Set Webhook Active, with URL `https://staging.coforge.cn/api/integrations/github/webhook`
and the generated webhook secret below. No event subscription is needed:
GitHub delivers `installation`, `installation_repositories` and
`github_app_authorization` to every GitHub App automatically, and none of them
appears under Permissions & events. The callback URL and the Webhook URL are
different endpoints; do not point one at the other.

Set these in the repository's **staging Environment** before a reviewed deployment:

- Variable `COFORGE_GITHUB_APP_SLUG`: the actual slug from the App's public URL
  (`https://github.com/apps/<slug>`), not its display name or numeric ID.
- Variable `COFORGE_GITHUB_APP_BOT_USER_ID`: the App's bot *user* id, e.g.
  `gh api users/<slug>[bot] --jq .id` (the `<slug>[bot]` GitHub account, not the
  App id from `gh api /apps/<slug>`). Used only to build the Agent commit
  `Co-authored-by` trailer; optional, absent means no trailer.
- Secret `COFORGE_GITHUB_CLIENT_SECRET`: generated in the GitHub App settings.
- Secret `COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY`: independently generated
  32-byte key encoded as 64 hexadecimal characters. Generate and store securely;
  never send it through chat. Retain this key across deployments. Replacing it
  makes existing ciphertext unreadable; users must disconnect and reconnect.
- Secret `COFORGE_GITHUB_WEBHOOK_SECRET`: independently generated, entered
  verbatim as the GitHub App's webhook secret. Optional: absent, the webhook
  route responds 503 and Settings falls back to its background/manual sync
  only, so this can be provisioned after the rest of the connection works.

Keep **Request user authorization (OAuth) during installation** enabled. GitHub
therefore disables the Setup URL and sends installation completion to the existing
authorization callback above. Leave **Redirect on update** disabled: GitHub ignores
it when the Setup URL is blank. CoForge validates a browser-bound installation
`state`, ignores the untrusted returned installation ID, and resynchronizes through
the authenticated GitHub user token. Later repository-access changes arrive through
GitHub webhooks and are also refreshed when Settings or the Project repository selector loads.

The workflow transfers these through restricted files. Compose mounts credentials
as secrets; none is stored in its `.env` or Web container environment.
Absent connection credentials leave the Settings integration unconfigured without
changing login behavior. This does not configure production or deploy automatically.

Settings no longer polls GitHub on every page load: it reads a database cache
and refreshes it in the background, kept fresh by the three webhook events
above (installation, installation_repositories, github_app_authorization).

Manual acceptance after configuration and approved migration/deployment:

- [ ] Open Settings → Integrations in light/dark and desktop/narrow layouts.
- [ ] Connect, accept GitHub authorization, and return to the same signed-in User.
- [ ] Cancel authorization; confirm a safe error and a working retry.
- [ ] Change account; GitHub shows its account picker. Cancellation or failed
  authorization retains the old connection; successful authorization replaces it.
- [ ] Configure opens GitHub's App installation page for a personal account or
  organization, where repository grants are managed. No repository list is shown
  on the CoForge integration card.
- [ ] Revoke authorization on GitHub; reopen Settings to request reauthorization.
- [ ] Disconnect; confirm the account disappears and the App remains installed.
- [ ] With the webhook secret configured, suspend then unsuspend the installation
  on GitHub; Settings reflects the change without a manual Refresh.
- [ ] Uninstall the App on GitHub; Settings shows "pending installation" without
  a manual Refresh.

Local database regression command (disposable migrated PostgreSQL only):
`GITHUB_TEST_DATABASE_URL=<local-url> mise exec -- bun test ./apps/web/test/github-connection.integration.ts`.
Tests substitute GitHub HTTP responses; they do not prove a live OAuth exchange.

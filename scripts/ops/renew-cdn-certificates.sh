#!/usr/bin/env bash
# Issues and deploys Let's Encrypt certificates for the Alibaba Cloud CDN
# accelerated domains that terminate TLS at the edge.
#
# Caddy's automatic Let's Encrypt only covers staging.coforge.cn, which Caddy
# serves directly (see docs/architecture.md). The three domains below are
# fronted by Alibaba Cloud CDN instead, and CDN needs its own certificate
# uploaded through the SetCdnDomainSSLCertificate API; Caddy issuing a
# certificate does nothing for traffic CDN terminates before it ever reaches
# Caddy.
#
# Frank's decision (2026-09-20, see docs/operations/cdn-certificates/):
# Alibaba moved SSL certificates to a paid subscription model on 2026-02-24,
# so the free per-domain certificate this runbook used before (see the old
# warning in docs/operations/aliyun-oss-cdn/staging-record.md, section 10) can no longer be
# re-issued from the console. This script replaces that manual, non-renewing
# path with acme.sh: DNS-01 validation through Alibaba DNS (dns_ali) proves
# domain ownership without exposing the origin, and the ali_cdn deploy hook
# pushes the issued certificate straight to the CDN domain. Both are official
# acme.sh integrations, not custom signing code:
#   - https://github.com/acmesh-official/acme.sh/wiki/dnsapi (dns_ali)
#   - https://github.com/acmesh-official/acme.sh/wiki/deployhooks (ali_cdn)
#
# Renewal is not this script's job: acme.sh's own daily cron entry
# (installed by `acme.sh --install`, see verify_acme_cron below) renews a
# certificate automatically as it nears expiry and re-invokes the deploy
# hook that this script registers on first run, because acme.sh persists a
# domain's deploy-hook configuration in its per-domain config file once
# `--deploy` has run for it. This script does not add a second scheduler; it
# only checks that the one acme.sh already owns exists.
#
# Usage:
#   Ali_Key=<ram-access-key-id> Ali_Secret=<ram-access-key-secret> \
#     scripts/ops/renew-cdn-certificates.sh
#
# Re-running this script is always safe: acme.sh skips a certificate that is
# not near expiry unless FORCE_RENEW=1 is set, and re-deploying an unchanged
# certificate to CDN is a no-op set call.
#
# See docs/operations/cdn-certificates/ for the RAM policy this needs, the
# first-run procedure, and how to roll back to a manually uploaded
# certificate.
set -euo pipefail

# --- Domain inventory --------------------------------------------------
# One CDN accelerated domain per line. Adding a production domain later is a
# one-line addition here; nothing else in this script encodes a domain name.
# Keep this list identical to the one documented in
# docs/operations/cdn-certificates/domains.md so the two cannot drift.
CDN_DOMAINS=(
	"files-staging.coforge.cn"
	"releases-staging.coforge.cn"
	"images-staging.coforge.cn"
)

ACME_HOME="${ACME_HOME:-$HOME/.acme.sh}"
ACME_BIN="$ACME_HOME/acme.sh"
# Pin this to a released tag (see https://github.com/acmesh-official/acme.sh/releases)
# for a reproducible first install; the default tracks the upstream default
# branch, which is acme.sh's own recommended install target but is not
# version-pinned.
ACME_GIT_REF="${ACME_GIT_REF:-master}"
ACME_ACCOUNT_EMAIL="${ACME_ACCOUNT_EMAIL:-}"
# Set to 1 to force-renew every domain regardless of its expiry, e.g. after
# rotating the account key. Never the default: acme.sh's own near-expiry
# check is what makes routine re-runs of this script idempotent.
FORCE_RENEW="${FORCE_RENEW:-0}"

log() {
	printf 'renew-cdn-certificates: %s\n' "$1" >&2
}

fail() {
	printf 'renew-cdn-certificates: %s\n' "$1" >&2
	exit 1
}

# Fails closed with the exact commands an operator needs, per the repository
# rule that a visible failure must name the real cause and a runnable fix
# (docs/agents/... failures-must-explain-and-give-commands). Never echoes the
# credential values themselves, only that they are missing.
require_credentials() {
	if [ -z "${Ali_Key:-}" ] || [ -z "${Ali_Secret:-}" ]; then
		{
			printf 'renew-cdn-certificates: Ali_Key and/or Ali_Secret are not set.\n'
			printf 'dns_ali (DNS-01 validation) and ali_cdn (certificate deployment) both read these two variables.\n'
			printf 'Create or locate a RAM AccessKey scoped to alidns:AddDomainRecord, alidns:DeleteDomainRecord,\n'
			printf 'alidns:DescribeDomainRecords and cdn:SetCdnDomainSSLCertificate (see docs/operations/cdn-certificates/ram-permissions.md),\n'
			printf 'then run:\n'
			printf '  export Ali_Key="<ram-access-key-id>"\n'
			printf '  export Ali_Secret="<ram-access-key-secret>"\n'
			printf '  %s\n' "$0"
		} >&2
		exit 1
	fi
}

# Installs acme.sh from the official git repository if it is not already
# present. This is one of acme.sh's own documented install methods
# (https://github.com/acmesh-official/acme.sh#3-or-with-git-recommend-for-developer):
# `git clone` + `./acme.sh --install`, chosen over the `curl | sh` one-liner
# so the fetched source can be reviewed and pinned via ACME_GIT_REF.
install_acme_sh() {
	if [ -x "$ACME_BIN" ]; then
		log "acme.sh already installed at $ACME_BIN"
		return 0
	fi
	command -v git >/dev/null 2>&1 || fail "git is required to install acme.sh; install git and re-run."
	local workdir=""
	cleanup_workdir() {
		[ -n "$workdir" ] && rm -rf "$workdir"
	}
	trap cleanup_workdir RETURN
	workdir="$(mktemp -d)"
	log "installing acme.sh (ref: $ACME_GIT_REF) into $ACME_HOME"
	git clone --quiet --depth 1 --branch "$ACME_GIT_REF" \
		https://github.com/acmesh-official/acme.sh.git "$workdir/acme.sh" >&2
	(
		cd "$workdir/acme.sh"
		if [ -n "$ACME_ACCOUNT_EMAIL" ]; then
			./acme.sh --install --home "$ACME_HOME" -m "$ACME_ACCOUNT_EMAIL"
		else
			./acme.sh --install --home "$ACME_HOME"
		fi
	) >&2
	[ -x "$ACME_BIN" ] || fail "acme.sh install did not produce an executable at $ACME_BIN"
}

# acme.sh --install writes a daily cron entry that runs `acme.sh --cron`
# (https://github.com/acmesh-official/acme.sh/wiki/How-to-install); that
# entry is the only renewal scheduler this system should have. This checks
# it exists rather than installing a second one, and tells the operator the
# exact command to restore it if something has removed it.
verify_acme_cron() {
	if crontab -l 2>/dev/null | grep -qF -- "$ACME_BIN"; then
		log "found an acme.sh entry in crontab -l"
		return 0
	fi
	log "warning: no acme.sh entry found in 'crontab -l' for this user; renewal will not run unattended."
	log "restore it with: $ACME_BIN --install-cronjob"
}

# Issues (or, near expiry, renews) the certificate for one domain via DNS-01
# through Alibaba DNS, then deploys it to the matching CDN domain. Running
# --deploy here also registers the ali_cdn hook in acme.sh's per-domain
# config, so acme.sh's own cron re-invokes it automatically on every future
# renewal without this script's help.
issue_and_deploy() {
	local domain="$1"
	# --server letsencrypt is explicit on purpose: acme.sh's own default CA is
	# ZeroSSL (https://github.com/acmesh-official/acme.sh/wiki/Server), so
	# leaving it out would quietly issue from a different CA than this runbook
	# documents, and would depend on whatever default the host happens to carry.
	local issue_args=(--home "$ACME_HOME" --issue --server letsencrypt --dns dns_ali -d "$domain")
	if [ "$FORCE_RENEW" = "1" ]; then
		issue_args+=(--force)
	fi
	log "issuing/renewing certificate for $domain"
	if ! "$ACME_BIN" "${issue_args[@]}"; then
		log "failed to issue/renew certificate for $domain"
		return 1
	fi
	log "deploying certificate for $domain to CDN"
	if ! DEPLOY_ALI_CDN_DOMAIN="$domain" "$ACME_BIN" --home "$ACME_HOME" --deploy -d "$domain" --deploy-hook ali_cdn; then
		log "failed to deploy certificate for $domain to CDN"
		return 1
	fi
	return 0
}

# Prints the certificate Alibaba Cloud CDN is actually serving for a domain,
# independent of what acme.sh believes it issued, so a run's own output is
# the evidence that the edge changed.
report_live_expiry() {
	local domain="$1" not_after
	if ! command -v openssl >/dev/null 2>&1; then
		printf '%s: openssl not available to verify\n' "$domain"
		return 0
	fi
	not_after="$(
		{
			if command -v timeout >/dev/null 2>&1; then
				timeout 10 openssl s_client -connect "$domain:443" -servername "$domain" </dev/null 2>/dev/null
			else
				openssl s_client -connect "$domain:443" -servername "$domain" </dev/null 2>/dev/null
			fi
		} | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2
	)"
	if [ -n "$not_after" ]; then
		printf '%s: notAfter=%s\n' "$domain" "$not_after"
	else
		printf '%s: could not observe a live certificate\n' "$domain"
	fi
}

main() {
	require_credentials
	install_acme_sh
	verify_acme_cron

	local failures=0
	for domain in "${CDN_DOMAINS[@]}"; do
		if ! issue_and_deploy "$domain"; then
			failures=$((failures + 1))
		fi
	done

	printf -- '--- observed CDN certificate expiry ---\n'
	for domain in "${CDN_DOMAINS[@]}"; do
		report_live_expiry "$domain"
	done

	if [ "$failures" -gt 0 ]; then
		fail "$failures of ${#CDN_DOMAINS[@]} domain(s) failed to issue or deploy; see the log above."
	fi
	log "all ${#CDN_DOMAINS[@]} domain(s) issued and deployed."
}

main "$@"

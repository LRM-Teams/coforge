# Container logs

Every service logs through Docker's `journald` driver (`x-journald-logging` in
`docker-compose.yml`). Under the rootless daemon the entries land in the
`deploy` user's own journal, so they survive the container recreation every
deploy performs. The default `json-file` log is deleted together with its
container, which is why `docker logs` alone only reaches back to the last deploy.

The journal must live on the data disk (`/data`), not the 50 GB system disk.
One-time host setup as root, before the first deploy that carries this
logging configuration:

```
mkdir -p /data/journal
chown root:systemd-journal /data/journal && chmod 2755 /data/journal
systemctl stop systemd-journald.socket systemd-journald-dev-log.socket \
  systemd-journald-audit.socket systemd-journald.service
cp -a /var/log/journal/. /data/journal/
echo '/data/journal /var/log/journal none bind,x-systemd.requires-mounts-for=/data 0 0' >> /etc/fstab
systemctl daemon-reload && mount /var/log/journal
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=20G\nSystemKeepFree=20G\nMaxRetentionSec=30day\n' \
  > /etc/systemd/journald.conf.d/coforge-staging.conf
systemctl start systemd-journald.socket systemd-journald-dev-log.socket \
  systemd-journald-audit.socket systemd-journald.service
findmnt /var/log/journal        # must show /dev/vdb[/journal]
```

`SystemMaxUse`/`SystemKeepFree` apply to the file system the journal is on, so
after the bind mount they are measured against `/data`; without the explicit
values journald would cap itself at 4 GiB. `MaxRetentionSec=30day` matches the
30-day runtime-log window in [`docs/observability/`](../../observability/correlation-and-retention.md).

Read the logs as `deploy`, by container name (the driver's `tag`):

```
journalctl --user -t coforge-staging-web-1 --since "2 hours ago" | grep web_push
journalctl --user -t coforge-staging-web-1 -o cat --since today    # message only
journalctl --user --disk-usage
```

`docker logs` still works for a running container.

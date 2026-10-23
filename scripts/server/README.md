# The server's one-time setup for the `patrolkit` user (Plan 54, M8)

The API runs as `patrolkit`, a system user with no login, no home and no sudo,
under systemd (`patrolkit.service`). Deploys log in as `ec2-user`, rsync into
`/opt/patrolkit`, and restart the service.

```bash
sudo useradd --system --no-create-home --shell /sbin/nologin patrolkit
sudo install -d -o ec2-user -g patrolkit -m 2750 /opt/patrolkit
sudo install -d -o root -g patrolkit -m 750 /etc/patrolkit
sudo install -o root -g patrolkit -m 640 <the .env> /etc/patrolkit/patrolkit.env
sudo install -o root -g root -m 644 patrolkit.service /etc/systemd/system/patrolkit.service
sudo systemctl daemon-reload && sudo systemctl enable --now patrolkit
```

- Settings: `sudoedit /etc/patrolkit/patrolkit.env`, then `sudo systemctl restart patrolkit`.
- Logs: `journalctl -u patrolkit -f`.
- Status: `systemctl status patrolkit`.

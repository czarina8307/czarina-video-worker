#!/usr/bin/env bash
# Einmaliges Server-Setup für einen frischen Ubuntu-24.04-Server (Hetzner Cloud).
# Als root ausführen:  curl -fsSL <raw-url>/deploy/bootstrap.sh | bash -s -- <github-repo-url>
# oder nach dem Klonen:  sudo bash deploy/bootstrap.sh
#
# Macht: System-Updates, Docker, Firewall (nur 22/80/443), fail2ban, automatische
# Sicherheitsupdates, Deploy-User "deploy" mit Docker-Rechten, Repo nach /opt/czarina-video-worker.
set -euo pipefail

REPO_URL="${1:-}"
APP_DIR=/opt/czarina-video-worker
DEPLOY_USER=deploy

if [[ $EUID -ne 0 ]]; then echo "Bitte als root ausführen." >&2; exit 1; fi

echo "==> System aktualisieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get upgrade -yq
apt-get install -yq --no-install-recommends ca-certificates curl git ufw fail2ban unattended-upgrades

echo "==> Docker installieren (offizielles Repo)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker

echo "==> Firewall: nur SSH, HTTP, HTTPS"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "==> fail2ban (SSH-Bruteforce-Schutz) + automatische Sicherheitsupdates"
cat > /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
EOF
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Deploy-User anlegen"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG docker "$DEPLOY_USER"
  mkdir -p /home/$DEPLOY_USER/.ssh
  # SSH-Keys von root (Hetzner legt sie bei der Server-Erstellung ab) übernehmen
  [[ -f /root/.ssh/authorized_keys ]] && cp /root/.ssh/authorized_keys /home/$DEPLOY_USER/.ssh/
  chown -R $DEPLOY_USER:$DEPLOY_USER /home/$DEPLOY_USER/.ssh
  chmod 700 /home/$DEPLOY_USER/.ssh
fi

echo "==> Repo nach $APP_DIR"
if [[ ! -d $APP_DIR/.git ]]; then
  if [[ -z "$REPO_URL" ]]; then
    echo "Kein Repo-URL angegeben – bitte $APP_DIR manuell klonen." >&2
  else
    git clone "$REPO_URL" "$APP_DIR"
  fi
fi
[[ -d $APP_DIR ]] && chown -R $DEPLOY_USER:$DEPLOY_USER "$APP_DIR"

echo "==> Docker-Logrotation + Live-Restore"
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" }, "live-restore": true }
EOF
systemctl restart docker

cat <<EOF

Fertig. Nächste Schritte (als Benutzer '$DEPLOY_USER'):
  1. DNS: A-Record der Worker-Domain auf diese Server-IP zeigen lassen.
  2. cp $APP_DIR/deploy/.env.example $APP_DIR/deploy/.env  &&  nano $APP_DIR/deploy/.env
  3. cd $APP_DIR/deploy && docker compose up -d --build
  4. curl https://<WORKER_DOMAIN>/health
Optional: SSH-Login für root deaktivieren (PermitRootLogin no in /etc/ssh/sshd_config).
EOF

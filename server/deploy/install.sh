#!/usr/bin/env bash
# Установка игрового сервера на чистый Ubuntu 24.04 (Hetzner CX23).
# Запускается из Cloud config при создании сервера, повторный запуск безопасен.
# Ставит Node.js 22, Caddy (HTTPS на <ip>.sslip.io), службу swrt,
# автообновление кода из GitHub и автообновления системы.
set -euo pipefail
exec > >(tee -a /var/log/swrt-install.log) 2>&1
echo "== swrt install $(date -Is)"

REPO_DIR=/opt/swrt
ENV_FILE=/etc/swrt.env
export DEBIAN_FRONTEND=noninteractive

# --- подкачка 1 ГБ: на малых тарифах (CPX02 — 1 ГБ памяти) установка и
#     обновления системы не упрутся в память ---
if ! swapon --show | grep -q /swapfile; then
  if [ ! -f /swapfile ]; then fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024; fi
  chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null; echo 'vm.swappiness=10' > /etc/sysctl.d/99-swrt.conf
fi

# --- пакеты ---
apt-get update -y
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades ufw

if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# --- пользователь и код ---
id swrt >/dev/null 2>&1 || useradd --system --home "$REPO_DIR" --shell /usr/sbin/nologin swrt
chown -R swrt:swrt "$REPO_DIR"
runuser -u swrt -- git -C "$REPO_DIR" config pull.ff only

# --- адрес: IPv4 из метаданных Hetzner → https://1-2-3-4.sslip.io ---
IP=$(curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || true)
[ -n "$IP" ] || IP=$(curl -fsS --max-time 5 https://api.ipify.org || true)
HOSTNAME_PUBLIC="$(echo "$IP" | tr '.' '-').sslip.io"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
grep -q '^PORT=' "$ENV_FILE" || echo "PORT=8080" >> "$ENV_FILE"
sed -i '/^PUBLIC_URL=/d' "$ENV_FILE"; echo "PUBLIC_URL=https://$HOSTNAME_PUBLIC" >> "$ENV_FILE"
chown root:swrt "$ENV_FILE"; chmod 640 "$ENV_FILE"

# --- служба ---
cat > /etc/systemd/system/swrt.service <<UNIT
[Unit]
Description=SW-RPG 2.0 game server (real-time battles)
After=network-online.target
Wants=network-online.target

[Service]
User=swrt
Group=swrt
WorkingDirectory=$REPO_DIR/server
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $REPO_DIR/server/index.js
Restart=always
RestartSec=2
LimitNOFILE=65536
MemoryMax=80%
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$REPO_DIR

[Install]
WantedBy=multi-user.target
UNIT

# --- автообновление кода: раз в 2 минуты ---
install -m 755 "$REPO_DIR/server/deploy/update.sh" /usr/local/bin/swrt-update
cat > /etc/systemd/system/swrt-update.service <<UNIT
[Unit]
Description=SW-RPG 2.0 server code update
[Service]
Type=oneshot
ExecStart=/usr/local/bin/swrt-update
UNIT
cat > /etc/systemd/system/swrt-update.timer <<UNIT
[Unit]
Description=SW-RPG 2.0 server code update every 2 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT

# --- HTTPS ---
cat > /etc/caddy/Caddyfile <<CADDY
{
	servers {
		protocols h1
	}
}

$HOSTNAME_PUBLIC {
	encode gzip
	reverse_proxy 127.0.0.1:8080
}
CADDY

# --- сеть: снаружи только 22, 80, 443 ---
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# --- автообновления системы (только безопасность, без перезагрузок) ---
cat > /etc/apt/apt.conf.d/20auto-upgrades <<APT
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
systemctl enable --now unattended-upgrades

systemctl daemon-reload
systemctl enable --now swrt.service swrt-update.timer
systemctl restart swrt.service
systemctl enable caddy
systemctl restart caddy

echo "== swrt ready: https://$HOSTNAME_PUBLIC/health"

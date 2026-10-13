#!/usr/bin/env bash
# Подтянуть новый код сервера из GitHub (main) и перезапустить службу.
# Перезапуск — только когда нет идущих боёв (busy=0 в /health); если бой
# затянулся, обновление ждёт до 30 минут, потом всё равно ставится.
set -euo pipefail
REPO_DIR=/opt/swrt
G="runuser -u swrt -- git -C $REPO_DIR"
$G fetch -q --depth 1 origin main
L=$($G rev-parse HEAD); R=$($G rev-parse origin/main)
[ "$L" = "$R" ] && exit 0

if ! $G diff --quiet "$L" "$R" -- server shared; then
  BUSY=$(curl -fsS --max-time 3 http://127.0.0.1:8080/health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).busy||0)}catch(e){console.log(0)}})' || echo 0)
  PENDING=/run/swrt-update-pending
  if [ "$BUSY" != "0" ]; then
    [ -f $PENDING ] || date +%s > $PENDING
    if [ $(( $(date +%s) - $(cat $PENDING) )) -lt 1800 ]; then
      echo "swrt-update: идут бои ($BUSY), обновление ждёт"; exit 0
    fi
  fi
  rm -f $PENDING
  $G reset -q --hard "$R"
  install -m 755 "$REPO_DIR/server/deploy/update.sh" /usr/local/bin/swrt-update
  systemctl restart swrt.service
  echo "swrt-update: сервер обновлён $L -> $R"
else
  $G reset -q --hard "$R"
fi

#!/usr/bin/env bash
set -euo pipefail

release_dir=/opt/sw-bot.release
app_dir=/opt/sw-bot
state_dir=/var/lib/sw-bot
env_file=/etc/sw-bot.env
service_user=sw-bot

if ! id "${service_user}" >/dev/null 2>&1; then
  useradd --system --home "${state_dir}" --shell /usr/sbin/nologin "${service_user}"
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-venv python3-pip

if [ ! -f "${env_file}" ]; then
  install -m 0600 "${release_dir}/deploy/gcp/sw-bot.env.template" "${env_file}"
  echo "Created ${env_file}. Add the real secrets, then run: sudo systemctl restart sw-bot" >&2
fi

python3 -m venv "${release_dir}/.venv"
"${release_dir}/.venv/bin/pip" install --no-cache-dir -r "${release_dir}/requirements.txt"

rm -rf "${app_dir}.previous"
if [ -d "${app_dir}" ]; then
  mv "${app_dir}" "${app_dir}.previous"
fi
mv "${release_dir}" "${app_dir}"
install -d -o "${service_user}" -g "${service_user}" -m 0750 "${state_dir}"
install -m 0644 "${app_dir}/deploy/gcp/sw-bot.service" /etc/systemd/system/sw-bot.service
chown -R root:root "${app_dir}"

systemctl daemon-reload
systemctl enable sw-bot.service
if ! grep -q 'replace-with-' "${env_file}"; then
  systemctl restart sw-bot.service
  systemctl --no-pager --full status sw-bot.service
else
  echo "Service installed but not started because ${env_file} still contains placeholders." >&2
fi

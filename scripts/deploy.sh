#!/bin/sh
# Deploy to a home server over SSH: sync the files the image needs, build it
# there, and (re)start the container.
#
#   DEPLOY_HOST=my-server scripts/deploy.sh
#
# DEPLOY_DEST is the folder on the server, relative to the home directory
# (default: daily-drip). The server's .env and config/ are never touched.
# On a first deploy they do not exist yet: the script builds the image, says
# what is missing, and starts nothing.
set -eu

host=${DEPLOY_HOST:?set DEPLOY_HOST to the SSH name of the server}
dest=${DEPLOY_DEST:-daily-drip}
cd "$(dirname "$0")/.."

ssh "$host" "mkdir -p '$dest' '$dest/config' && chmod 750 '$dest' && chmod 700 '$dest/config'"

# -rlt, not -a: keep the server's own owners and folder modes.
rsync -rlt --delete src fonts "$host:$dest/"
rsync -rlt Dockerfile .dockerignore compose.yaml package.json bun.lock .env.example "$host:$dest/"

ssh "$host" "cd '$dest' && docker build -q -t daily-drip:local . >/dev/null && echo 'image built'"

missing=$(ssh "$host" "cd '$dest' && { [ -s .env ] || echo .env; [ -s config/riot-cookie ] || echo config/riot-cookie; }")
if [ -n "$missing" ]; then
  echo "Not started. Missing on $host, in ~/$dest:"
  echo "$missing" | sed 's/^/  /'
  echo "See the README (Run it in Docker), then run this script again."
  exit 1
fi

ssh "$host" "cd '$dest' && chmod 600 .env config/riot-cookie && docker compose up -d && docker compose ps"

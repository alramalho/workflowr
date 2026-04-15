#!/usr/bin/env bash
set -euo pipefail

# Load env vars
set -a
source .env
set +a

HOST="89.167.115.145"
USER="root"
REPO="https://${GITHUB_DEPLOY_TOKEN}@github.com/alramalho/workflowr.git"
REMOTE_DIR="/root/workflowr"
ENV_FILE=".env.prod"
LOCAL_DB="apps/backend/data/tokens.db"
SSH_KEY="$HOME/.ssh/hetzner"
SEED_DB=0

# Parse flags
for arg in "$@"; do
  case $arg in
    --seed-db) SEED_DB=1 ;;
  esac
done

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no"

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
  echo "==> Uncommitted changes detected:"
  git status --short
  echo ""
  read -p "Commit all changes before deploying? [y/N] " REPLY
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    read -p "Commit message: " MSG
    git add -A
    git commit -m "$MSG"
    git push
  else
    read -p "Deploy anyway with unpushed changes? [y/N] " REPLY2
    if [[ ! "$REPLY2" =~ ^[Yy]$ ]]; then
      echo "Aborted."
      exit 0
    fi
  fi
else
  # Check for committed but unpushed changes
  git fetch --quiet
  if [ -n "$(git log origin/main..HEAD --oneline 2>/dev/null)" ]; then
    echo "==> Unpushed commits:"
    git log origin/main..HEAD --oneline
    read -p "Push before deploying? [Y/n] " REPLY
    if [[ ! "$REPLY" =~ ^[Nn]$ ]]; then
      git push
    fi
  fi
fi

echo "==> Uploading .env.prod..."
scp $SSH_OPTS "$ENV_FILE" "$USER@$HOST:$REMOTE_DIR/.env" 2>/dev/null || {
  # First deploy — dir doesn't exist yet, upload after clone
  FIRST_DEPLOY=1
}

echo "==> Connecting to $HOST..."
ssh $SSH_OPTS "$USER@$HOST" bash -s -- "$REPO" "$REMOTE_DIR" "${FIRST_DEPLOY:-0}" <<'REMOTE'
set -euo pipefail
REPO="$1"
DIR="$2"
FIRST_DEPLOY="$3"

# Install docker if missing
if ! command -v docker &>/dev/null; then
  echo "==> Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# Clone or pull
if [ ! -d "$DIR" ]; then
  echo "==> Cloning repo..."
  git clone "$REPO" "$DIR"
else
  echo "==> Pulling latest..."
  cd "$DIR"
  git pull --ff-only
fi

cd "$DIR"

# Backup SQLite DB before deploy
BACKUP_DIR="$DIR/backups"
mkdir -p "$BACKUP_DIR"
DB_FILE=$(docker compose exec -T bot find /app/data -name "*.db" 2>/dev/null || true)
if [ -n "$DB_FILE" ]; then
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  docker compose cp "bot:$DB_FILE" "$BACKUP_DIR/tokens_$TIMESTAMP.db"
  echo "==> Backed up DB to backups/tokens_$TIMESTAMP.db"
  # Keep only last 10 backups
  ls -t "$BACKUP_DIR"/*.db 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
else
  echo "==> No DB found (first deploy?), skipping backup"
fi

echo "==> Building and starting containers..."
docker compose up --build -d

echo "==> Done! Running containers:"
docker compose ps
REMOTE

# If first deploy, upload .env now that the dir exists
if [ "${FIRST_DEPLOY:-0}" = "1" ]; then
  echo "==> Uploading .env.prod (first deploy)..."
  scp $SSH_OPTS "$ENV_FILE" "$USER@$HOST:$REMOTE_DIR/.env"
  echo "==> Restarting with env..."
  ssh $SSH_OPTS "$USER@$HOST" "cd $REMOTE_DIR && docker compose up --build -d"
fi

# Seed local DB to server
if [ "$SEED_DB" = "1" ]; then
  if [ ! -f "$LOCAL_DB" ]; then
    echo "Error: Local DB not found at $LOCAL_DB" >&2
    exit 1
  fi
  echo "==> Seeding DB from local $LOCAL_DB..."
  # Get the docker volume mount path
  VOLUME_PATH=$(ssh $SSH_OPTS "$USER@$HOST" "docker volume inspect workflowr_bot-data -f '{{.Mountpoint}}'")
  # Backup existing remote DB if present
  ssh $SSH_OPTS "$USER@$HOST" bash -s -- "$VOLUME_PATH" <<'SEEDREMOTE'
  if [ -f "$1/tokens.db" ]; then
    cp "$1/tokens.db" "$1/tokens.db.bak"
    echo "==> Backed up existing remote DB to tokens.db.bak"
  fi
SEEDREMOTE
  scp $SSH_OPTS "$LOCAL_DB" "$USER@$HOST:$VOLUME_PATH/tokens.db"
  echo "==> DB seeded. Restarting bot..."
  ssh $SSH_OPTS "$USER@$HOST" "cd $REMOTE_DIR && docker compose restart bot"
fi

echo "==> Deploy complete!"

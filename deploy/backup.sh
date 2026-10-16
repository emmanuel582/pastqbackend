#!/usr/bin/env bash
# Nightly PastQ data backup: consistent SQLite snapshots plus every other file
# in the data volume, kept for KEEP_DAYS. Installed as /usr/local/bin/pastq-backup.
set -euo pipefail

KEEP_DAYS="${KEEP_DAYS:-14}"
DEST="${BACKUP_DIR:-/var/backups/pastq}"
VOLUME="$(docker volume ls -q | grep -E '(^|_)pastq-hostinger-data$' | head -n1)"
[ -n "$VOLUME" ] || { echo "pastq data volume not found" >&2; exit 1; }
SRC="$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME")"

STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# SQLite files are copied with the online backup API so a running pipeline
# never produces a torn snapshot; everything else is archived as-is.
cd "$SRC"
find . -name '*.db' -type f | while read -r db; do
  mkdir -p "$WORK/$(dirname "$db")"
  sqlite3 "$db" ".backup '$WORK/$db'"
done
tar --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' -cf "$WORK/files.tar" .

install -d -m 700 "$DEST"
tar -C "$WORK" -czf "$DEST/pastq-$STAMP.tgz" .
chmod 600 "$DEST/pastq-$STAMP.tgz"
find "$DEST" -name 'pastq-*.tgz' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $DEST/pastq-$STAMP.tgz"

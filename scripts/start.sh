#!/bin/sh
set -e

# If an Azure Files mount is present, point the app's mutable data dir at it so the persistent
# global leaderboard (data/leaderboard.json) survives container restarts + redeploys. The app uses
# normal fs calls (writeFileAtomic mkdir's data/); we just make data/ resolve to the share.
#
# Only RUNTIME-MUTABLE state belongs on the share. assets/ (GLB models) and client/dist (the built
# UI) ship in the image and MUST NOT be linked — they change with each deploy and the share would
# pin a stale copy. The maps (assets/maps/maps.json) are committed to git + ship in the image; they
# are authored via the editor at build/author time, not persisted at runtime, so they stay in-image.
DATA_MOUNT="${DATA_MOUNT:-/app/appdata}"

if [ -d "$DATA_MOUNT" ]; then
  echo "Persistent storage detected at $DATA_MOUNT — linking data/"
  mkdir -p "$DATA_MOUNT/data"
  rm -rf /app/data
  ln -sf "$DATA_MOUNT/data" /app/data
  echo "  Linked /app/data -> $DATA_MOUNT/data"
else
  echo "No persistent mount at $DATA_MOUNT — leaderboard uses ephemeral container storage."
fi

# Run the TypeScript server directly via tsx (see Dockerfile rationale). exec so tini is PID-1 parent
# and SIGTERM reaches node for a clean shutdown.
exec npx tsx server/index.ts

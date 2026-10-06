#!/usr/bin/env bash
#
# Installs Ollama and pre-pulls the model Season 4 uses.
#
# Runs from devcontainer.json as onCreateCommand, which is the step Codespaces
# prebuilds capture — so with prebuilds enabled players get a container that already
# has the model, instead of waiting for a multi-GB download on first start.
#
# The release is pinned and its checksum verified rather than piping a remote script
# into a shell. This is a secure-coding repo; we should not ship the thing we teach
# people to avoid. To move to a newer Ollama, bump OLLAMA_VERSION and replace
# OLLAMA_SHA256 with the matching line from that release's sha256sum.txt.

set -euo pipefail

OLLAMA_VERSION="v0.35.1"
OLLAMA_SHA256="9fcd79ac4575b2bd31b992eee18b1000c8ad126b451627c8f8cd091714cfbb10"
OLLAMA_ARCHIVE="ollama-linux-amd64.tar.zst"
MODEL="${SCG_AI_MODEL:-qwen2.5:7b}"

log() { echo "[setup-ollama] $*"; }

if ! command -v ollama >/dev/null 2>&1; then
    log "installing ollama ${OLLAMA_VERSION}"

    # The release archive is zstd-compressed; the base image may not have zstd.
    if ! command -v zstd >/dev/null 2>&1; then
        sudo apt-get update -qq && sudo apt-get install -y -qq zstd
    fi

    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    curl -fsSL -o "${tmp}/${OLLAMA_ARCHIVE}" \
        "https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/${OLLAMA_ARCHIVE}"

    log "verifying checksum"
    echo "${OLLAMA_SHA256}  ${tmp}/${OLLAMA_ARCHIVE}" | sha256sum -c - \
        || { echo "[setup-ollama] CHECKSUM MISMATCH — refusing to install"; exit 1; }

    sudo tar -I zstd -xf "${tmp}/${OLLAMA_ARCHIVE}" -C /usr/local
    log "installed $(ollama --version 2>/dev/null || echo ollama)"
else
    log "ollama already present, skipping install"
fi

# `ollama pull` talks to the daemon, so bring one up just for the download.
# The long-lived server is started by postStartCommand.
if ollama list 2>/dev/null | grep -q "^${MODEL%%:*}"; then
    log "model ${MODEL} already pulled, skipping"
    exit 0
fi

log "starting a temporary server to pull ${MODEL}"
ollama serve > /tmp/ollama-setup.log 2>&1 &
serve_pid=$!

for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then break; fi
    sleep 1
done

log "pulling ${MODEL} (several GB, this is the slow step)"
ollama pull "${MODEL}"

kill "${serve_pid}" 2>/dev/null || true
wait "${serve_pid}" 2>/dev/null || true
log "done"

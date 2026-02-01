#!/usr/bin/env bash
set -e

# ── paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

NARGO="$HOME/.nargo/bin/nargo"
SUNSPOT="$HOME/gopath/bin/sunspot"
CIRCUIT_NAME="rlwe_audit"
TARGET_DIR="target"
ACIR="$TARGET_DIR/${CIRCUIT_NAME}.json"
WITNESS="$TARGET_DIR/${CIRCUIT_NAME}.gz"
CCS="$TARGET_DIR/${CIRCUIT_NAME}.ccs"
PK="$TARGET_DIR/${CIRCUIT_NAME}.pk"
VK="$TARGET_DIR/${CIRCUIT_NAME}.vk"
PROOF="$TARGET_DIR/${CIRCUIT_NAME}.proof"
PW="$TARGET_DIR/${CIRCUIT_NAME}.pw"
PROVER_TOML="Prover.toml"

timer() {
    local start=$SECONDS
    "$@"
    echo "  ($(( SECONDS - start ))s)"
}

# ── Prover.toml input ─────────────────────────────────────────────────
# --paste: interactive paste mode (paste content, press Ctrl+D)
# file arg: copy from file
# pipe: read from stdin
# no args: use existing Prover.toml
if [ "$1" = "--paste" ] || [ "$1" = "-p" ]; then
    echo "Paste Prover.toml content, then press Ctrl+D:"
    echo "---"
    cat > "$PROVER_TOML"
    echo "---"
    echo "Prover.toml saved"
elif [ -n "$1" ] && [ -f "$1" ]; then
    cp "$1" "$PROVER_TOML"
    echo "Prover.toml loaded from: $1"
elif [ ! -t 0 ]; then
    cat > "$PROVER_TOML"
    echo "Prover.toml loaded from stdin"
else
    if [ ! -f "$PROVER_TOML" ]; then
        echo "ERROR: No Prover.toml found."
        echo ""
        echo "Usage:"
        echo "  ./prove_audit.sh -p         # paste mode (paste + Ctrl+D)"
        echo "  ./prove_audit.sh            # use existing Prover.toml"
        echo "  ./prove_audit.sh file.toml  # load from file"
        echo ""
        echo "Prover.toml format:"
        echo "  wa_commitment = \"0x...\"    # pub: Poseidon1(owner_x, owner_y)"
        echo "  ct_commitment = \"0x...\"    # pub: Poseidon2 sponge of packed ciphertext"
        echo "  secret_key = \"0x...\"       # BJJ secret key"
        echo "  c0_packed = [\"0x...\", ...]  # 10 packed Fields"
        echo "  c1_packed = [\"0x...\", ...]  # 147 packed Fields"
        echo "  r = [\"0x...\", ...]          # 1024 signed noise values"
        echo "  e1_sparse = [\"0x...\", ...]  # 64 signed noise values"
        echo "  e2 = [\"0x...\", ...]         # 1024 signed noise values"
        echo "  k0 = [\"0x...\", ...]         # 64 quotient witnesses"
        echo "  k1 = [\"0x...\", ...]         # 1024 quotient witnesses"
        exit 1
    fi
    echo "Using existing Prover.toml"
fi

echo ""
echo "=== RLWE Audit Proof Pipeline ==="
echo ""

# ── 1. nargo execute ───────────────────────────────────────────────────
echo "[1/5] nargo execute"
timer "$NARGO" execute

# ── 2. sunspot compile (skip if .ccs exists) ──────────────────────────
if [ -f "$CCS" ]; then
    echo "[2/5] sunspot compile -- skipped (.ccs exists)"
else
    echo "[2/5] sunspot compile"
    timer "$SUNSPOT" compile "$ACIR"
fi

# ── 3. sunspot setup (skip if pk+vk exist) ────────────────────────────
if [ -f "$PK" ] && [ -f "$VK" ]; then
    echo "[3/5] sunspot setup -- skipped (pk/vk exist)"
else
    echo "[3/5] sunspot setup"
    timer "$SUNSPOT" setup "$CCS"
fi

# ── 4. sunspot prove ──────────────────────────────────────────────────
echo "[4/5] sunspot prove"
timer "$SUNSPOT" prove "$ACIR" "$WITNESS" "$CCS" "$PK"

# ── 5. sunspot verify ─────────────────────────────────────────────────
echo "[5/5] sunspot verify"
timer "$SUNSPOT" verify "$VK" "$PROOF" "$PW"

echo ""
echo "=== Done ==="
echo ""

# ── output hex ─────────────────────────────────────────────────────────
echo "-- audit proof hex --"
printf '0x'; xxd -p "$PROOF" | tr -d '\n'
echo ""
echo ""
echo "-- audit public witness hex --"
printf '0x'; xxd -p "$PW" | tr -d '\n'
echo ""

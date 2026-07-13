"""Thin wrapper around the Google Workspace CLI (gws).

Auth is handled by gws itself — run `gws auth setup` once, then `gws auth login`.
See README.md for setup instructions.
"""
import json
import shutil
import subprocess


class GwsError(RuntimeError):
    pass


def run_gws(*args: str) -> str:
    """Run a gws command and return its stdout. Raises GwsError on failure."""
    if shutil.which("gws") is None:
        raise GwsError(
            "gws CLI not found. Install with `npm install -g @googleworkspace/cli`, "
            "then run `gws auth setup` and `gws auth login`."
        )
    result = subprocess.run(["gws", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise GwsError(result.stderr.strip() or f"gws exited with code {result.returncode}")
    return result.stdout


def gws_json(*args: str):
    """Run a gws command and parse its JSON stdout (None for empty output)."""
    out = run_gws(*args).strip()
    return json.loads(out) if out else None

"""Developer entry for the PC application; use GAR for managed lifecycle."""
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js is required; normal managed startup uses gar sim start.')
    raise SystemExit(subprocess.call([node, str(ROOT / 'simulation/host-server.cjs'), *sys.argv[1:]]))

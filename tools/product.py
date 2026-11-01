#!/usr/bin/env python3
"""Delegate Product composition to the pinned common tools repository."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    manifest = json.loads((ROOT / 'product.json').read_text(encoding='utf-8'))
    cli = ROOT / manifest['components']['tools'] / 'composition/cli.py'
    raise SystemExit(subprocess.call([sys.executable, str(cli), '--root', str(ROOT), *sys.argv[1:]]))

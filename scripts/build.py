"""Build the shared C++/LVGL UI. Python stdlib + Emscripten; no npm required."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXPORTS = ['receive', 'hardware', 'button', 'refresh', 'snapshot', 'take_action']

def dependencies():
    lock = json.loads((ROOT / 'dependencies.json').read_text(encoding='utf-8'))
    result = {}
    for name, item in lock.items():
        folder = ROOT / '.cache/deps' / name
        marker = folder / '.archive-sha256'
        if not marker.exists() or marker.read_text() != item['sha256']:
            print('Downloading', name, item['version'], flush=True)
            archive_path = ROOT / '.cache' / (name + '.zip')
            blob = archive_path.read_bytes() if archive_path.exists() else urllib.request.urlopen(item['url'], timeout=90).read()
            if hashlib.sha256(blob).hexdigest() != item['sha256']:
                raise ValueError(f'{name}: archive checksum mismatch')
            # Extract files only, strip the archive root and reject path traversal.
            with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                for info in archive.infolist():
                    relative = Path(*Path(info.filename).parts[1:])
                    if not relative.parts or info.is_dir():
                        continue
                    dest = folder / relative
                    if not dest.resolve().is_relative_to(folder.resolve()):
                        raise ValueError('Unsafe dependency archive')
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(archive.read(info))
            marker.write_text(item['sha256'])
        result[name] = folder
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wsl', metavar='DISTRO', help='Build with Emscripten in this WSL distribution')
    args = parser.parse_args()
    if args.wsl:
        if os.name != 'nt':
            parser.error('--wsl is a Windows option')
        script = subprocess.check_output(['wsl', '-d', args.wsl, '--exec', 'wslpath', '-a', Path(__file__).resolve().as_posix()], text=True).strip()
        # A fixed script, with paths passed as positional arguments instead of interpolated shell code.
        command = 'export EMSDK_QUIET=1; if [ -f "$HOME/.cache/gar-ui/emsdk/emsdk_env.sh" ]; then . "$HOME/.cache/gar-ui/emsdk/emsdk_env.sh"; fi; exec python3 "$1"'
        subprocess.run(['wsl', '-d', args.wsl, '--exec', 'bash', '-c', command, 'gar-build', script], check=True)
        return
    if not shutil.which('emcc'):
        parser.error('Activate Emscripten first, or use --wsl DISTRO on Windows. See README.md.')
    deps = dependencies()
    app = ROOT / 'sources/gar-vibe-ui/vibe-remote/compact-ui'
    command = [sys.executable, str(ROOT / 'sources/gar-tools/web-simulator/build_lvgl.py'),
               '--lvgl', str(deps['lvgl']), '--json-library', str(deps['ArduinoJson']),
               '--app', str(app), '--config', str(app / 'lv_conf.h'),
               '--source', str(app.parent / 'touch-ui/vibe_jp_16.c'), '--app-api', 'minimal',
               '--width', '135', '--height', '240', '--jobs', '4',
               '--output', str(ROOT / 'simulation/runtime'), '--cache', str(ROOT / '.cache/objects')]
    for name in EXPORTS:
        command += ['--export', 'gar_app_' + name]
    subprocess.run(command, check=True)

if __name__ == '__main__':
    main()

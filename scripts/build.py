"""Build the shared device application for Node/WASM; no VM or npm required."""
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
EXPORTS = ['feed_bytes', 'hardware', 'button', 'tick', 'snapshot', 'take_output',
           'pairing', 'authenticated', 'transport_reset']
EMSDK_VERSION = '3.1.64'
EMSDK_SHA256 = '2a61fc9d271cab441918b9495d1103c56b5062fd46c721e2d988a6dbbdf6cd01'


def cache_root():
    shared = os.environ.get('GAR_BUILD_CACHE')
    if shared:
        path = Path(shared)
        if not path.is_absolute():
            raise ValueError('GAR_BUILD_CACHE must be absolute.')
        return path / 'stickc-simulation'
    return ROOT / '.cache'


def extract_archive(blob, folder):
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        for info in archive.infolist():
            relative = Path(*Path(info.filename).parts[1:])
            if not relative.parts or info.is_dir():
                continue
            dest = folder / relative
            if not dest.resolve().is_relative_to(folder.resolve()):
                raise ValueError('Unsafe dependency archive')
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Dependency symlinks are not supported')
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(archive.read(info))


def compiler_environment():
    """A fixed SDK, isolated from the PC's PlatformIO and other compilers."""
    if sys.platform != 'linux':
        raise ValueError('SDK bootstrap runs in the GAR Linux build environment.')
    sdk = cache_root() / ('emsdk-' + EMSDK_VERSION)
    marker = sdk / '.archive-sha256'
    if not marker.is_file() or marker.read_text() != EMSDK_SHA256:
        url = 'https://codeload.github.com/emscripten-core/emsdk/zip/refs/tags/' + EMSDK_VERSION
        blob = urllib.request.urlopen(url, timeout=90).read()
        if hashlib.sha256(blob).hexdigest() != EMSDK_SHA256:
            raise ValueError('emsdk archive checksum mismatch')
        extract_archive(blob, sdk)
        marker.write_text(EMSDK_SHA256)
    env = dict(os.environ, EMSDK=str(sdk), EM_CONFIG=str(sdk / '.emscripten'))
    emcc = sdk / 'upstream/emscripten/emcc.py'
    if not emcc.is_file() or not (sdk / '.emscripten').is_file():
        subprocess.run([sys.executable, str(sdk / 'emsdk.py'), 'install', EMSDK_VERSION], env=env, check=True)
        subprocess.run([sys.executable, str(sdk / 'emsdk.py'), 'activate', EMSDK_VERSION], env=env, check=True)
    # ZIP extraction preserves bytes, not executable permissions. The SDK invokes
    # its Python entry points directly via these tiny executable wrappers.
    wrappers = sdk / 'gar-bin'
    wrappers.mkdir(exist_ok=True)
    for name in ('emcc', 'em++'):
        wrapper = wrappers / name
        wrapper.write_text('#!/bin/sh\nexec python3 "' + str(sdk / 'upstream/emscripten' / (name + '.py')) + '" "$@"\n')
        wrapper.chmod(0o755)
    env['PATH'] = str(wrappers) + os.pathsep + env.get('PATH', '')
    return env

def dependencies():
    lock = json.loads((ROOT / 'dependencies.json').read_text(encoding='utf-8'))
    result = {}
    for name, item in lock.items():
        folder = cache_root() / 'deps' / name
        marker = folder / '.archive-sha256'
        if not marker.exists() or marker.read_text() != item['sha256']:
            print('Downloading', name, item['version'], flush=True)
            archive_path = ROOT / '.cache' / (name + '.zip')
            blob = archive_path.read_bytes() if archive_path.exists() else urllib.request.urlopen(item['url'], timeout=90).read()
            if hashlib.sha256(blob).hexdigest() != item['sha256']:
                raise ValueError(f'{name}: archive checksum mismatch')
            extract_archive(blob, folder)
            marker.write_text(item['sha256'])
        result[name] = folder
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wsl', metavar='DISTRO', help='Build with Emscripten in this WSL distribution')
    parser.add_argument('--bootstrap', action='store_true', help='Install the fixed SDK into the GAR build cache (Linux)')
    parser.add_argument('--ui-only', action='store_true', help='Build isolated CompactUi for its unit tests')
    parser.add_argument('--output', type=Path, help='Override generated runtime directory')
    args = parser.parse_args()
    if args.wsl:
        if os.name != 'nt':
            parser.error('--wsl is a Windows option')
        script = subprocess.check_output(['wsl', '-d', args.wsl, '--exec', 'wslpath', '-a', Path(__file__).resolve().as_posix()], text=True).strip()
        # A fixed script, with paths passed as positional arguments instead of interpolated shell code.
        command = 'export EMSDK_QUIET=1; if [ -f "$HOME/.cache/gar-ui/emsdk/emsdk_env.sh" ]; then . "$HOME/.cache/gar-ui/emsdk/emsdk_env.sh"; fi; exec python3 "$@"'
        forwarded = ['--ui-only'] if args.ui_only else []
        subprocess.run(['wsl', '-d', args.wsl, '--exec', 'bash', '-c', command, 'gar-build', script, *forwarded], check=True)
        return
    env = compiler_environment() if args.bootstrap else dict(os.environ)
    if not shutil.which('emcc', path=env.get('PATH')):
        parser.error('Activate Emscripten first, or use --wsl DISTRO on Windows. See README.md.')
    deps = dependencies()
    app = ROOT / 'sources/gar-vibe-ui/vibe-remote/compact-ui'
    firmware = ROOT / 'firmware/stickc-plus2'
    output = args.output or ROOT / ('simulation/ui-runtime' if args.ui_only else 'simulation/runtime')
    config = firmware / 'include/stickc_lv_conf.h'
    command = [sys.executable, str(ROOT / 'sources/gar-tools/web-simulator/build_lvgl.py'),
               '--lvgl', str(deps['lvgl']), '--json-library', str(deps['ArduinoJson']),
               '--app', str(app), '--config', str(config),
               '--source', str(app.parent / 'touch-ui/vibe_jp_16.c'), '--app-api', 'minimal',
               '--width', '135', '--height', '240', '--jobs', '4',
               '--output', str(output), '--cache', str(cache_root() / ('ui-objects' if args.ui_only else 'app-objects'))]
    exports = ['receive', 'hardware', 'button', 'refresh', 'snapshot', 'take_action'] if args.ui_only else EXPORTS
    if not args.ui_only:
        command += ['--entry', str(ROOT / 'simulation/host-entry.cpp'),
                    '--include', str(firmware / 'include'),
                    '--source', str(firmware / 'src/DeviceApplication.cpp')]
    for name in exports:
        command += ['--export', 'gar_app_' + name]
    subprocess.run(command, env=env, check=True)
    if not args.ui_only:
        metadata = json.loads((output / 'build.json').read_text(encoding='utf-8'))
        sources = [ROOT / 'simulation/host-entry.cpp', firmware / 'src/DeviceApplication.cpp',
                   *sorted((firmware / 'include').glob('*.h')),
                   *sorted(app.glob('*.cpp')), *sorted(app.glob('*.h')),
                   app.parent / 'touch-ui/vibe_jp_16.c', Path(__file__), ROOT / 'dependencies.json']
        digest = hashlib.sha256()
        for source in sources:
            digest.update(source.relative_to(ROOT).as_posix().encode())
            digest.update(source.read_bytes())
        metadata.update(applicationSourceHash=digest.hexdigest(),
                        runtime='shared-device-application',lvglHeapBytes=48*1024,
                        toolchain=EMSDK_VERSION if args.bootstrap else 'external')
        (output / 'build.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')

if __name__ == '__main__':
    main()

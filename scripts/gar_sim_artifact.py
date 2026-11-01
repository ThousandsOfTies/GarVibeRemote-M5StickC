#!/usr/bin/env python3
"""Build the portable application and export a self-contained GAR SIM_APP."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from gar_target_artifact import BuildError, invalidate_output, require_plain_path, clean_output

ROOT = Path(__file__).resolve().parents[1]
PANEL_FILES = ('index.html', 'adapter.mjs', 'style.css')
SERVER_FILES = ('host-server.cjs', 'host-controller.cjs')
RUNTIME_FILES = ('lvgl-ui.mjs', 'lvgl-ui.wasm', 'build.json')


def publish_bundle():
    output = invalidate_output()
    simulation = ROOT / 'simulation'
    for relative in (*PANEL_FILES, *SERVER_FILES, *('runtime/' + name for name in RUNTIME_FILES)):
        source = require_plain_path(simulation / relative)
        if not source.is_file() or not source.stat().st_size:
            raise BuildError(f'Missing simulator input: {source}')
    runtime_metadata = json.loads((simulation / 'runtime/build.json').read_text(encoding='utf-8'))
    if runtime_metadata.get('width') != 135 or runtime_metadata.get('height') != 240:
        raise BuildError('Runtime display is not the Plus2 135x240 display.')
    if runtime_metadata.get('runtime') != 'shared-device-application' or not runtime_metadata.get('applicationSourceHash'):
        raise BuildError('Build the shared DeviceApplication runtime before packaging; a UI-only WASM is insufficient.')
    wasm = (simulation / 'runtime/lvgl-ui.wasm').read_bytes()
    if not wasm.startswith(b'\x00asm\x01\x00\x00\x00'):
        raise BuildError('Simulator runtime is not a WebAssembly 1 module.')
    spec = importlib.util.spec_from_file_location('gar_panel_export', ROOT / 'sources/gar-tools/web-simulator/serve.py')
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.gar-sim-', dir=output.parent) as temporary:
        temporary = Path(temporary)
        panel = temporary / 'panel'
        panel.mkdir()
        for name in PANEL_FILES:
            shutil.copyfile(simulation / name, panel / name)
        bundle = temporary / 'bundle'
        host = bundle / 'files/host'
        server.export_panel(panel, host)
        for name in SERVER_FILES:
            shutil.copyfile(simulation / name, host / name)
        (host / 'runtime').mkdir()
        for name in RUNTIME_FILES:
            shutil.copyfile(simulation / 'runtime' / name, host / 'runtime' / name)
        descriptor = {
            'schema_version': 1, 'executable': 'node', 'entrypoint': 'host-server.cjs',
            'args': ['--port', '8772'],
            'health_url': 'http://127.0.0.1:8772/health',
            'panel_url': 'http://127.0.0.1:8772/',
        }
        (host / 'host-process.json').write_text(json.dumps(descriptor, indent=2) + '\n', encoding='utf-8')
        manifest = {'name': 'GarVibeRemote-M5StickC', 'target': 'esp32',
                    'entrypoint': 'host-server.cjs',
                    'deploy': {'app': {'files': [{'src': 'files/host', 'dest': '.'}]}}}
        (bundle / 'artifact.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        if output.exists():
            output.rename(temporary / 'previous')
        bundle.rename(output)
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=['build', 'clean'], default='build')
    args = parser.parse_args(argv)
    try:
        invalidate_output()
        if args.action == 'clean':
            clean_output()
            return 0
        if os.environ.get('GAR_SIM_ENVIRONMENT', 'host_process') != 'host_process':
            raise BuildError('Select GAR SimulationEnvironment=host_process.')
        subprocess.run([sys.executable, str(ROOT / 'scripts/build.py'), '--bootstrap'], check=True)
        # Keep the focused UI regression suite runnable without exposing its
        # direct state-injection ABI in the deployed application.
        subprocess.run([sys.executable, str(ROOT / 'scripts/build.py'), '--bootstrap', '--ui-only'], check=True)
        output = publish_bundle()
        print(f'GAR portable simulator ready: {output}')
        return 0
    except (BuildError, ValueError, OSError, subprocess.SubprocessError) as error:
        print(f'GAR simulator build failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

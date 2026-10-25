"""Static HTTP only: no bridge, process launcher, hooks, or device configuration."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'sources/gar-tools/web-simulator/serve.py'
spec = importlib.util.spec_from_file_location('gar_simulator_server', path)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
if __name__ == '__main__':
    server.main(default_panel=ROOT / 'simulation')

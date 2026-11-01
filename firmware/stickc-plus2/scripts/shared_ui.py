from pathlib import Path
import sys
Import('env')
root = Path(env['PROJECT_DIR']).resolve().parents[1]
sys.path.insert(0, str(root / 'scripts'))
from composition import product
selected = product()
generated = selected.prepare()
app = selected.components['application']
board = selected.components['board']
env.Append(CPPPATH=[str(generated), str(board / selected.profile['adapter']['include']),
                    *[str(app / path) for path in selected.data['build']['includes']]])
env.Append(CPPDEFINES=[('LV_CONF_PATH', (Path(env['PROJECT_DIR']) / 'include/stickc_lv_conf.h').as_posix())])

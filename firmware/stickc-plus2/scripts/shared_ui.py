from pathlib import Path
Import('env')
root=Path(env['PROJECT_DIR']).resolve().parents[1]
app=root/'sources/gar-vibe-ui/vibe-remote'
env.Append(CPPPATH=[str(app/'compact-ui'),str(app/'touch-ui')])
env.Append(CPPDEFINES=[('LV_CONF_PATH',(Path(env['PROJECT_DIR'])/'include/stickc_lv_conf.h').as_posix())])

#pragma once
#include "lv_conf.h"
// The Web build has ample memory. The native ESP32 needs a smaller static
// LVGL object heap; this UI uses only fixed labels and a few selection rows.
#undef LV_MEM_SIZE
#define LV_MEM_SIZE (48U * 1024U)

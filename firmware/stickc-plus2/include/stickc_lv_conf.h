#pragma once
#include "lv_conf.h"
#include "application_config.h"
// Use the Product's same memory budget on firmware and the PC host.
#undef LV_MEM_SIZE
#define LV_MEM_SIZE GAR_APPLICATION_LVGL_HEAP_BYTES

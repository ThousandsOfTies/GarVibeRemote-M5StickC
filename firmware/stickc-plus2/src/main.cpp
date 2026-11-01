#include <Arduino.h>
#include <M5Unified.h>
#include <BluetoothSerial.h>
#include <freertos/stream_buffer.h>
#include <atomic>
#include <lvgl.h>
#include "DeviceApplication.h"

#if !defined(CONFIG_BT_SPP_ENABLED)
#error This Product requires ESP32 Bluetooth Classic SPP.
#endif

namespace {
using stickc::Transport;
constexpr char bluetoothName[]="GarVibe-M5StickC-Plus2";
BluetoothSerial bluetooth;
StreamBufferHandle_t sppRx=nullptr;
std::atomic<bool> sppOverflow{false};
std::atomic<unsigned> sppEpoch{0};
std::atomic<uint32_t> confirmNumber{UINT32_MAX};
std::atomic<int> authenticationResult{0};
unsigned observedEpoch=0;
stickc::DeviceApplication::Hardware facts;
stickc::DeviceApplication app(
  [](Transport link,const std::string& packet) {
    if(link==Transport::usb)Serial.write(reinterpret_cast<const uint8_t*>(packet.data()),packet.size());
    else if(link==Transport::spp && facts.sppReady && bluetooth.hasClient())
      bluetooth.write(reinterpret_cast<const uint8_t*>(packet.data()),packet.size());
  },
  [](bool accept) { bluetooth.confirmReply(accept); });
lv_disp_buf_t drawBuffer;
lv_color_t pixels[135*16];
uint32_t clockAt=0,batteryAt=0;

void flush(lv_disp_drv_t* driver,const lv_area_t* area,lv_color_t* colors) {
  M5.Display.pushImage(area->x1,area->y1,area->x2-area->x1+1,area->y2-area->y1+1,
                       reinterpret_cast<lgfx::rgb565_t*>(colors));
  lv_disp_flush_ready(driver);
}
void readUsb() {
  char bytes[256];
  for(int i=0;i<4 && Serial.available();++i) {
    size_t count=0;
    while(count<sizeof(bytes) && Serial.available())bytes[count++]=static_cast<char>(Serial.read());
    app.feed(Transport::usb,bytes,count);
  }
}
void readSpp() {
  if(!facts.sppReady)return;
  const unsigned epoch=sppEpoch.load();
  if(epoch!=observedEpoch) {
    observedEpoch=epoch;app.resetTransport(Transport::spp);
    uint8_t discarded[256];
    while(xStreamBufferReceive(sppRx,discarded,sizeof(discarded),0)){}
  }
  facts.sppClient=bluetooth.hasClient();app.hardware(facts);
  if(sppOverflow.exchange(false))app.discardTransport(Transport::spp);
  char bytes[256];
  // Bluetooth callbacks only buffer bytes. The shared runtime, JSON and LVGL
  // all run on this task, just as they run on one event loop in the PC host.
  for(int i=0;i<4;++i) {
    const size_t count=xStreamBufferReceive(sppRx,bytes,sizeof(bytes),0);
    if(!count)break;
    if(!facts.sppClient)continue;
    if(sppOverflow.exchange(false))app.discardTransport(Transport::spp);
    app.feed(Transport::spp,bytes,count);
  }
}
void button(m5::Button_Class& button,char key) {
  if(button.wasPressed())app.button(key,1);
  if(button.wasReleased())app.button(key,0);
}
}
void setup() {
  pinMode(4,OUTPUT);digitalWrite(4,HIGH);Serial.begin(115200);
  auto config=M5.config();config.internal_mic=false;config.internal_spk=false;
  config.fallback_board=m5::board_t::board_M5StickCPlus2;M5.begin(config);
  M5.Display.setRotation(0);M5.Display.setBrightness(96);M5.Display.fillScreen(TFT_BLACK);
  facts.battery=std::max(0,static_cast<int>(M5.Power.getBatteryLevel()));
  facts.width=M5.Display.width();facts.height=M5.Display.height();facts.board=static_cast<int>(M5.getBoard());
  lv_init();lv_disp_buf_init(&drawBuffer,pixels,nullptr,135*16);
  lv_disp_drv_t driver;lv_disp_drv_init(&driver);driver.hor_res=135;driver.ver_res=240;
  driver.buffer=&drawBuffer;driver.flush_cb=flush;lv_disp_drv_register(&driver);
  sppRx=xStreamBufferCreate(16384,1);
  if(sppRx) {
    bluetooth.register_callback([](esp_spp_cb_event_t event,esp_spp_cb_param_t*) {
      if(event==ESP_SPP_SRV_OPEN_EVT || event==ESP_SPP_CLOSE_EVT)sppEpoch.fetch_add(1);
    });
    bluetooth.onData([](const uint8_t* data,size_t size) {
      if(xStreamBufferSend(sppRx,data,size,0)!=size)sppOverflow.store(true);
    });
    bluetooth.enableSSP();
    bluetooth.onConfirmRequest([](uint32_t number) { confirmNumber.store(number); });
    bluetooth.onAuthComplete([](bool success) { authenticationResult.store(success?1:-1); });
    facts.sppReady=bluetooth.begin(bluetoothName);
  }
  app.begin(facts);clockAt=millis();
}
void loop() {
  const auto now=millis();lv_tick_inc(now-clockAt);clockAt=now;
  M5.update();
  const auto code=confirmNumber.exchange(UINT32_MAX);
  if(code!=UINT32_MAX)app.pairingRequested(code);
  const auto result=authenticationResult.exchange(0);
  if(result)app.authenticated(result>0);
  readUsb();readSpp();
  // The enclosure's C / GPIO35 is exposed as BtnPWR by M5Unified.
  button(M5.BtnA,'A');button(M5.BtnB,'B');button(M5.BtnPWR,'C');
  if(M5.BtnPWR.pressedFor(6000))M5.Power.powerOff();
  if(now-batteryAt>=10000) {
    batteryAt=now;facts.battery=std::max(0,static_cast<int>(M5.Power.getBatteryLevel()));app.hardware(facts);
  }
  app.step();lv_task_handler();delay(5);
}

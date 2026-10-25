#include <Arduino.h>
#include <M5Unified.h>
#include <ArduinoJson.h>
#include <lvgl.h>
#include "CompactUi.cpp"

namespace {
vibe::CompactUi ui;
lv_disp_buf_t drawBuffer;
lv_color_t pixels[135*16];
std::string incoming;
uint32_t clockAt=0,heartbeatAt=0,batteryAt=0;
bool connected=false,dropping=false;
int battery=0;
constexpr size_t maxPacket=65536;
constexpr uint32_t leaseMs=8000;

void flush(lv_disp_drv_t* driver,const lv_area_t* area,lv_color_t* colors) {
  M5.Display.pushImage(area->x1,area->y1,area->x2-area->x1+1,area->y2-area->y1+1,
                       reinterpret_cast<lgfx::rgb565_t*>(colors));
  lv_disp_flush_ready(driver);
}
void hello() {
  JsonDocument d;d["type"]="deviceInfo";d["device"]="m5stickc-plus2";
  d["firmware"]="gar-stickc-usb-v1";d["transport"]="usb-serial";
  d["width"]=M5.Display.width();d["height"]=M5.Display.height();
  d["board"]=static_cast<int>(M5.getBoard());d["battery"]=battery;
  serializeJson(d,Serial);Serial.println();
}
void setConnected(bool value) {
  if(connected==value)return;
  connected=value;ui.hardware(true,connected,battery);
}
void receive(const std::string& packet) {
  JsonDocument d;
  if(deserializeJson(d,packet))return;
  const std::string type=d["type"] | "";
  if(type=="hello" || type=="ping") {
    heartbeatAt=millis();setConnected(true);
    if(type=="hello")hello();return;
  }
  if(type=="snapshot") {
    JsonDocument answer;deserializeJson(answer,ui.snapshot());answer["type"]="snapshot";
    answer["transport"]="usb-serial";serializeJson(answer,Serial);Serial.println();return;
  }
  if(type=="state" || type=="sessions" || type=="ack") {
    if(ui.receive(packet.c_str())) {heartbeatAt=millis();setConnected(true);}
  }
}
void readSerial() {
  // Bound per-loop work so a large packet cannot starve display/button updates.
  for(int i=0;i<1024 && Serial.available();++i) {
    const char c=Serial.read();if(c=='\r')continue;
    if(c=='\n') {
      if(!dropping && !incoming.empty())receive(incoming);
      incoming.clear();dropping=false;
    } else if(!dropping) {
      if(incoming.size()<maxPacket)incoming+=c;
      else {incoming.clear();dropping=true;}
    }
  }
}
void button(m5::Button_Class& button,char key) {
  auto edge=[key](int phase) {
    ui.button(key,phase);
    if(connected) {
      JsonDocument d;d["type"]="button";d["button"]=std::string(1,key);d["phase"]=phase?"down":"up";
      serializeJson(d,Serial);Serial.println();
    }
  };
  if(button.wasPressed())edge(1);
  if(button.wasReleased())edge(0);
}
}
void setup() {
  // Plus2 must assert HOLD after powering up. No radio is initialized.
  pinMode(4,OUTPUT);digitalWrite(4,HIGH);
  Serial.begin(115200);
  auto config=M5.config();
  config.internal_mic=false;config.internal_spk=false;
  config.fallback_board=m5::board_t::board_M5StickCPlus2;
  M5.begin(config);
  M5.Display.setRotation(0);M5.Display.setBrightness(96);M5.Display.fillScreen(TFT_BLACK);
  battery=std::max(0,static_cast<int>(M5.Power.getBatteryLevel()));
  lv_init();lv_disp_buf_init(&drawBuffer,pixels,nullptr,135*16);
  lv_disp_drv_t driver;lv_disp_drv_init(&driver);driver.hor_res=135;driver.ver_res=240;
  driver.buffer=&drawBuffer;driver.flush_cb=flush;lv_disp_drv_register(&driver);
  ui.begin();ui.hardware(true,false,battery);
  const char* waiting=R"({"type":"state","session":{"id":"usb","name":"USB接続待ち"},"agent":{"status":"idle","message":"PCからの接続を待っています。"}})";
  ui.receive(waiting);
  clockAt=millis();incoming.reserve(4096);hello();
}
void loop() {
  const auto now=millis();lv_tick_inc(now-clockAt);clockAt=now;
  M5.update();readSerial();
  // readSerial may advance heartbeatAt beyond the loop's earlier timestamp.
  // Sample after receiving to avoid unsigned underflow and false disconnects.
  if(connected && millis()-heartbeatAt>leaseMs)setConnected(false);
  // Plus2's GPIO35 button is labelled C on the enclosure, but M5Unified
  // exposes it as BtnPWR (its BtnC belongs to other boards).
  button(M5.BtnA,'A');button(M5.BtnB,'B');button(M5.BtnPWR,'C');
  if(M5.BtnPWR.pressedFor(6000))M5.Power.powerOff();
  if(now-batteryAt>=10000) {
    batteryAt=now;battery=std::max(0,static_cast<int>(M5.Power.getBatteryLevel()));
    ui.hardware(true,connected,battery);
  }
  ui.refresh();
  auto action=ui.takeAction();
  if(!action.empty() && connected) {
    JsonDocument d;deserializeJson(d,action);d["source"]="m5stickc-plus2-usb";
    serializeJson(d,Serial);Serial.println();
  }
  lv_task_handler();delay(5);
}

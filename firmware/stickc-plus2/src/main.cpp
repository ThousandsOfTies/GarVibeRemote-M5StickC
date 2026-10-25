#include <Arduino.h>
#include <M5Unified.h>
#include <ArduinoJson.h>
#include <BluetoothSerial.h>
#include <freertos/stream_buffer.h>
#include <atomic>
#include <lvgl.h>
#include "DeviceLink.h"
#include "PairingConsent.h"
#include "CompactUi.cpp"

#if !defined(CONFIG_BT_SPP_ENABLED)
#error This Product requires ESP32 Bluetooth Classic SPP.
#endif

namespace {
using stickc::Transport;
constexpr char bluetoothName[]="GarVibe-M5StickC-Plus2";
vibe::CompactUi ui;
BluetoothSerial bluetooth;
StreamBufferHandle_t sppRx=nullptr;
std::atomic<bool> sppOverflow{false};
std::atomic<unsigned> sppEpoch{0};
std::atomic<uint32_t> confirmNumber{UINT32_MAX};
std::atomic<int> authenticationResult{0};
stickc::PairingConsent pairing;
unsigned authenticationAttempts=0;
int lastAuthentication=0;
unsigned observedEpoch=0;
bool sppStarted=false,sppClient=false;
bool pairingScreenVisible=false;
stickc::JsonLines usbLines,sppLines;
stickc::DeviceLease lease;
lv_disp_buf_t drawBuffer;
lv_color_t pixels[135*16];
uint32_t clockAt=0,batteryAt=0;
int battery=0;

void flush(lv_disp_drv_t* driver,const lv_area_t* area,lv_color_t* colors) {
  M5.Display.pushImage(area->x1,area->y1,area->x2-area->x1+1,area->y2-area->y1+1,
                       reinterpret_cast<lgfx::rgb565_t*>(colors));
  lv_disp_flush_ready(driver);
}
void send(Transport link,const JsonDocument& doc) {
  std::string packet;serializeJson(doc,packet);packet+='\n';
  if(link==Transport::usb)Serial.write(reinterpret_cast<const uint8_t*>(packet.data()),packet.size());
  else if(link==Transport::spp && sppStarted && bluetooth.hasClient())
    bluetooth.write(reinterpret_cast<const uint8_t*>(packet.data()),packet.size());
}
void hardware() { ui.hardware(true,pairingScreenVisible || lease.owner()!=Transport::none,battery); }
void pairingInfo(JsonDocument& doc) {
  doc["pairingMode"]="ssp-numeric-comparison";doc["pairingState"]=pairing.state();
  doc["authenticationAttempts"]=authenticationAttempts;
  doc["lastAuthentication"]=lastAuthentication>0?"success":lastAuthentication<0?"failed":"not-observed";
}
void pairingScreen(const char* message,bool choices=false) {
  pairingScreenVisible=true;
  JsonDocument d;d["type"]="sessions";
  auto s=d["sessions"].to<JsonArray>().add<JsonObject>();
  s["session"]["id"]="bluetooth-pairing";s["session"]["name"]="Bluetooth登録";
  s["ui"]["id"]=pairing.id();s["ui"]["state"]=choices?"waiting":"idle";s["ui"]["message"]=message;
  if(choices) {
    auto actions=s["ui"]["actions"].to<JsonArray>();
    auto yes=actions.add<JsonObject>();yes["id"]="yes";yes["label"]="YES";
    auto no=actions.add<JsonObject>();no["id"]="no";no["label"]="NO";
  }
  std::string packet;serializeJson(d,packet);ui.receive(packet.c_str());hardware();
}
void pollPairing() {
  const auto code=confirmNumber.exchange(UINT32_MAX);
  if(code!=UINT32_MAX) {
    if(lease.owner()!=Transport::none)bluetooth.confirmReply(false);
    else {
      pairing.begin(millis());
      char message[240];snprintf(message,sizeof(message),
        "番号 %06lu\nPCと同じ番号ですか？\nCでYESを選び、Aで決定してください。",static_cast<unsigned long>(code));
      pairingScreen(message,true);
    }
  }
  const auto result=authenticationResult.exchange(0);
  if(result) {
    ++authenticationAttempts;lastAuthentication=result;
    const bool visible=pairing.active();pairing.authenticated(result>0);
    if(visible)pairingScreen(result>0?"登録できました。\nPCの接続中継を起動してください。":"登録に失敗しました。\nPCからもう一度登録してください。");
  }
  const bool awaiting=pairing.confirming();
  if(pairing.expire(millis())) {
    if(awaiting)bluetooth.confirmReply(false);
    pairingScreen("登録を時間切れで中止しました。\nPCからもう一度登録してください。");
  }
}
void hello(Transport link) {
  JsonDocument d;d["type"]="deviceInfo";d["device"]="m5stickc-plus2";
  d["protocol"]="gar-compact-v1";d["firmware"]="gar-stickc-spp-v1";d["transport"]=stickc::name(link);
  d["activeTransport"]=stickc::name(lease.owner());d["bluetoothName"]=bluetoothName;d["sppReady"]=sppStarted;
  d["width"]=M5.Display.width();d["height"]=M5.Display.height();
  d["board"]=static_cast<int>(M5.getBoard());d["battery"]=battery;
  pairingInfo(d);
  send(link,d);
}
void receive(Transport link,const std::string& packet) {
  JsonDocument d;if(deserializeJson(d,packet))return;
  const std::string type=d["type"] | "";
  if(type=="snapshot") {
    JsonDocument answer;deserializeJson(answer,ui.snapshot());answer["type"]="snapshot";
    answer["transport"]=stickc::name(link);answer["activeTransport"]=stickc::name(lease.owner());
    answer["sppReady"]=sppStarted;answer["sppClient"]=sppClient;pairingInfo(answer);send(link,answer);return;
  }
  if(type=="goodbye") {
    if(lease.release(link))hardware();
    return;
  }
  if(type=="hello") {
    if(pairing.active()) { JsonDocument busy;busy["type"]="busy";busy["activeTransport"]="pairing";send(link,busy); }
    else if(lease.claim(link,millis())) { pairingScreenVisible=false;hardware();hello(link); }
    else { JsonDocument busy;busy["type"]="busy";busy["activeTransport"]=stickc::name(lease.owner());send(link,busy); }
    return;
  }
  if(type=="ping") { if(lease.renew(link,millis()))hardware();return; }
  if(link!=lease.owner())return;
  if(type=="state" || type=="sessions" || type=="ack") {
    if(ui.receive(packet.c_str())) {lease.renew(link,millis());hardware();}
  }
}
void readUsb() {
  for(int i=0;i<1024 && Serial.available();++i)
    usbLines.byte(Serial.read(),[](const std::string& s){receive(Transport::usb,s);});
}
void readSpp() {
  if(!sppStarted)return;
  const unsigned epoch=sppEpoch.load();
  if(epoch!=observedEpoch) {
    observedEpoch=epoch;sppLines.reset();
    uint8_t discarded[256];
    while(xStreamBufferReceive(sppRx,discarded,sizeof(discarded),0)){}
    if(lease.release(Transport::spp))hardware();
  }
  const bool client=bluetooth.hasClient();
  if(client!=sppClient) {
    sppClient=client;sppLines.reset();
    if(!client && lease.release(Transport::spp))hardware();
  }
  if(sppOverflow.exchange(false))sppLines.discard();
  uint8_t bytes[256];
  // The Bluetooth callback only buffers bytes; JSON/LVGL stays on the main task.
  for(int i=0;i<4;++i) {
    const size_t count=xStreamBufferReceive(sppRx,bytes,sizeof(bytes),0);
    if(!count)break;
    if(!client)continue;
    if(sppOverflow.exchange(false))sppLines.discard();
    for(size_t j=0;j<count;++j)
      sppLines.byte(bytes[j],[](const std::string& s){receive(Transport::spp,s);});
  }
}
void button(m5::Button_Class& button,char key) {
  auto edge=[key](int phase) {
    ui.button(key,phase);
    if(!pairing.active() && lease.owner()!=Transport::none) {
      JsonDocument d;d["type"]="button";d["button"]=std::string(1,key);d["phase"]=phase?"down":"up";
      send(lease.owner(),d);
    }
  };
  if(button.wasPressed())edge(1);
  if(button.wasReleased())edge(0);
}
}
void setup() {
  pinMode(4,OUTPUT);digitalWrite(4,HIGH);Serial.begin(115200);
  auto config=M5.config();config.internal_mic=false;config.internal_spk=false;
  config.fallback_board=m5::board_t::board_M5StickCPlus2;M5.begin(config);
  M5.Display.setRotation(0);M5.Display.setBrightness(96);M5.Display.fillScreen(TFT_BLACK);
  battery=std::max(0,static_cast<int>(M5.Power.getBatteryLevel()));
  lv_init();lv_disp_buf_init(&drawBuffer,pixels,nullptr,135*16);
  lv_disp_drv_t driver;lv_disp_drv_init(&driver);driver.hor_res=135;driver.ver_res=240;
  driver.buffer=&drawBuffer;driver.flush_cb=flush;lv_disp_drv_register(&driver);
  ui.begin();hardware();
  ui.receive(R"({"type":"state","session":{"id":"connection","name":"PC接続待ち"},"agent":{"status":"idle","message":"BluetoothまたはUSBでPCから接続してください。"}})");
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
    sppStarted=bluetooth.begin(bluetoothName);
  }
  clockAt=millis();hello(Transport::usb);
}
void loop() {
  const auto now=millis();lv_tick_inc(now-clockAt);clockAt=now;
  M5.update();pollPairing();readUsb();readSpp();
  if(lease.expire(millis()))hardware();
  // The enclosure's C / GPIO35 is exposed as BtnPWR by M5Unified.
  button(M5.BtnA,'A');button(M5.BtnB,'B');button(M5.BtnPWR,'C');
  if(M5.BtnPWR.pressedFor(6000))M5.Power.powerOff();
  if(now-batteryAt>=10000) {
    batteryAt=now;battery=std::max(0,static_cast<int>(M5.Power.getBatteryLevel()));hardware();
  }
  ui.refresh();const auto action=ui.takeAction();
  if(!action.empty() && pairing.active()) {
    JsonDocument d;deserializeJson(d,action);
    const std::string id=d["uiId"]|"",answer=d["actionId"]|"";
    if((d["sessionId"]|std::string())=="bluetooth-pairing" && (answer=="yes" || answer=="no") && pairing.answer(id,answer=="yes")) {
      bluetooth.confirmReply(answer=="yes");
      pairingScreen(answer=="yes"?"PCでも番号を確認して、接続を完了してください。":"登録を中止しました。");
    }
  } else if(!action.empty() && lease.owner()!=Transport::none) {
    JsonDocument d;deserializeJson(d,action);
    d["source"]=lease.owner()==Transport::spp?"m5stickc-plus2-spp":"m5stickc-plus2-usb";
    send(lease.owner(),d);
  }
  lv_task_handler();delay(5);
}

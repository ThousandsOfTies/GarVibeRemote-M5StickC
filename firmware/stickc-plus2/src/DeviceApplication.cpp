#include "DeviceApplication.h"
#include "CompactUi.cpp"
#include <cstdio>
#include <utility>

namespace stickc {
namespace { constexpr char bluetoothName[]="GarVibe-M5StickC-Plus2"; }
DeviceApplication::DeviceApplication(Send send,ConfirmPairing confirm)
  :send_(std::move(send)),confirm_(std::move(confirm)) {}

void DeviceApplication::begin(const Hardware& hardware) {
  hardware_=hardware;ui_.begin();updateHardware();
  ui_.receive(R"({"type":"state","session":{"id":"connection","name":"PC接続待ち"},"agent":{"status":"idle","message":"BluetoothまたはUSBでPCから接続してください。"}})");
  hello(Transport::usb);
}
void DeviceApplication::updateHardware() {
  ui_.hardware(hardware_.powered,pairingScreenVisible_ || lease_.owner()!=Transport::none,hardware_.battery);
}
void DeviceApplication::hardware(const Hardware& hardware) {
  if(hardware.powered==hardware_.powered && hardware.sppReady==hardware_.sppReady &&
     hardware.sppClient==hardware_.sppClient && hardware.battery==hardware_.battery &&
     hardware.width==hardware_.width && hardware.height==hardware_.height && hardware.board==hardware_.board)return;
  const bool streamChanged=hardware.sppClient!=hardware_.sppClient ||
    hardware.sppReady!=hardware_.sppReady;
  const bool poweredOff=hardware_.powered && !hardware.powered;
  hardware_=hardware;
  if(streamChanged) {
    sppLines_.reset();
    if(!hardware_.sppClient || !hardware_.sppReady)lease_.release(Transport::spp);
  }
  if(poweredOff) {
    usbLines_.reset();sppLines_.reset();lease_.release(Transport::usb);lease_.release(Transport::spp);
    for(char key:std::string("ABC"))ui_.button(key,-1);
  }
  updateHardware();
}
void DeviceApplication::send(Transport link,const JsonDocument& document) const {
  if(link==Transport::none)return;
  if(link==Transport::spp && (!hardware_.sppReady || !hardware_.sppClient))return;
  std::string packet;serializeJson(document,packet);packet+='\n';send_(link,packet);
}
void DeviceApplication::pairingInfo(JsonDocument& document) const {
  document["pairingMode"]="ssp-numeric-comparison";document["pairingState"]=pairing_.state();
  document["authenticationAttempts"]=authenticationAttempts_;
  document["lastAuthentication"]=lastAuthentication_>0?"success":lastAuthentication_<0?"failed":"not-observed";
}
void DeviceApplication::pairingScreen(const char* message,bool choices) {
  pairingScreenVisible_=true;
  JsonDocument document;document["type"]="sessions";
  auto session=document["sessions"].to<JsonArray>().add<JsonObject>();
  session["session"]["id"]="bluetooth-pairing";session["session"]["name"]="Bluetooth登録";
  session["ui"]["id"]=pairing_.id();session["ui"]["state"]=choices?"waiting":"idle";session["ui"]["message"]=message;
  if(choices) {
    auto actions=session["ui"]["actions"].to<JsonArray>();
    auto yes=actions.add<JsonObject>();yes["id"]="yes";yes["label"]="YES";
    auto no=actions.add<JsonObject>();no["id"]="no";no["label"]="NO";
  }
  std::string packet;serializeJson(document,packet);ui_.receive(packet.c_str());updateHardware();
}
void DeviceApplication::pairingRequested(uint32_t number) {
  if(!hardware_.powered)return;
  if(lease_.owner()!=Transport::none) { confirm_(false);return; }
  pairing_.begin(lv_tick_get());
  char message[240];std::snprintf(message,sizeof(message),
    "番号 %06lu\nPCと同じ番号ですか？\nCでYESを選び、Aで決定してください。",static_cast<unsigned long>(number));
  pairingScreen(message,true);
}
void DeviceApplication::authenticated(bool success) {
  if(!hardware_.powered)return;
  ++authenticationAttempts_;lastAuthentication_=success?1:-1;
  const bool visible=pairing_.active();pairing_.authenticated(success);
  if(visible)pairingScreen(success?"登録できました。\nPCの接続中継を起動してください。":"登録に失敗しました。\nPCからもう一度登録してください。");
}
void DeviceApplication::hello(Transport link) const {
  JsonDocument document;document["type"]="deviceInfo";document["device"]="m5stickc-plus2";
  document["protocol"]="gar-compact-v1";document["firmware"]="gar-stickc-spp-v1";
  document["transport"]=name(link);document["activeTransport"]=name(lease_.owner());
  document["bluetoothName"]=bluetoothName;document["sppReady"]=hardware_.sppReady;
  document["width"]=hardware_.width;document["height"]=hardware_.height;
  document["board"]=hardware_.board;document["battery"]=hardware_.battery;
  pairingInfo(document);send(link,document);
}
std::string DeviceApplication::snapshot() const {
  JsonDocument document;deserializeJson(document,ui_.snapshot());
  document["activeTransport"]=name(lease_.owner());document["sppReady"]=hardware_.sppReady;
  document["sppClient"]=hardware_.sppClient;pairingInfo(document);
  std::string packet;serializeJson(document,packet);return packet;
}
void DeviceApplication::receive(Transport link,const std::string& packet) {
  JsonDocument document;if(deserializeJson(document,packet))return;
  const std::string type=document["type"]|"";
  if(type=="snapshot") {
    JsonDocument answer;deserializeJson(answer,snapshot());answer["type"]="snapshot";
    answer["transport"]=name(link);send(link,answer);return;
  }
  if(type=="goodbye") { if(lease_.release(link))updateHardware();return; }
  if(type=="hello") {
    if(pairing_.active()) {
      JsonDocument busy;busy["type"]="busy";busy["activeTransport"]="pairing";send(link,busy);
    } else if(lease_.claim(link,lv_tick_get())) {
      pairingScreenVisible_=false;updateHardware();hello(link);
    } else {
      JsonDocument busy;busy["type"]="busy";busy["activeTransport"]=name(lease_.owner());send(link,busy);
    }
    return;
  }
  if(type=="ping") { if(lease_.renew(link,lv_tick_get()))updateHardware();return; }
  if(link!=lease_.owner())return;
  if(type=="state" || type=="sessions" || type=="ack") {
    if(ui_.receive(packet.c_str())) { lease_.renew(link,lv_tick_get());updateHardware(); }
  }
}
void DeviceApplication::feed(Transport link,const char* bytes,size_t size) {
  if(!hardware_.powered || (link!=Transport::usb && link!=Transport::spp))return;
  if(link==Transport::spp && (!hardware_.sppReady || !hardware_.sppClient))return;
  auto& lines=link==Transport::usb?usbLines_:sppLines_;
  for(size_t i=0;i<size;++i)lines.byte(bytes[i],[&](const std::string& packet){receive(link,packet);});
}
void DeviceApplication::resetTransport(Transport link) {
  if(link==Transport::usb)usbLines_.reset();else if(link==Transport::spp)sppLines_.reset();else return;
  if(lease_.release(link))updateHardware();
}
void DeviceApplication::discardTransport(Transport link) {
  if(link==Transport::usb)usbLines_.discard();else if(link==Transport::spp)sppLines_.discard();
}
void DeviceApplication::button(char key,int phase) {
  if(!hardware_.powered || (key!='A' && key!='B' && key!='C'))return;
  ui_.button(key,phase);
  if((phase==0 || phase==1) && !pairing_.active() && lease_.owner()!=Transport::none) {
    JsonDocument document;document["type"]="button";document["button"]=std::string(1,key);
    document["phase"]=phase?"down":"up";send(lease_.owner(),document);
  }
}
void DeviceApplication::step() {
  if(!hardware_.powered)return;
  const bool awaiting=pairing_.confirming();
  if(pairing_.expire(lv_tick_get())) {
    if(awaiting)confirm_(false);
    pairingScreen("登録を時間切れで中止しました。\nPCからもう一度登録してください。");
  }
  if(lease_.expire(lv_tick_get()))updateHardware();
  ui_.refresh();const auto action=ui_.takeAction();
  if(!action.empty() && pairing_.active()) {
    JsonDocument document;deserializeJson(document,action);
    const std::string id=document["uiId"]|"",answer=document["actionId"]|"";
    if((document["sessionId"]|std::string())=="bluetooth-pairing" && (answer=="yes" || answer=="no") && pairing_.answer(id,answer=="yes")) {
      confirm_(answer=="yes");
      pairingScreen(answer=="yes"?"PCでも番号を確認して、接続を完了してください。":"登録を中止しました。");
    }
  } else if(!action.empty() && lease_.owner()!=Transport::none) {
    JsonDocument document;deserializeJson(document,action);
    document["source"]=lease_.owner()==Transport::spp?"m5stickc-plus2-spp":"m5stickc-plus2-usb";
    send(lease_.owner(),document);
  }
}
}

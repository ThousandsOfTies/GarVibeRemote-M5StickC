// Node host ABI. Initialize the generic display with gar_lv_init() first.
// gar_app_tick() owns the clock; do not additionally call gar_lv_tick().
#include "DeviceApplication.h"
#include "application_config.h"
#include "gar_board_config.h"
#include <deque>

namespace {
std::deque<std::string> outgoing;
std::string snapshot,result;
vibe::DeviceApplication::Hardware facts;
vibe::DeviceApplication app(
  {gar_application::device,gar_application::firmware,gar_application::bluetooth_name,gar_application::source_prefix},
  [](vibe::Transport link,const std::string& data) {
    JsonDocument document;document["transport"]=vibe::name(link);document["data"]=data;
    std::string packet;serializeJson(document,packet);outgoing.push_back(std::move(packet));
  },
  [](bool accepted) {
    JsonDocument document;document["type"]="pairing-confirm";document["accepted"]=accepted;
    std::string packet;serializeJson(document,packet);outgoing.push_back(std::move(packet));
  });
vibe::Transport transport(int link) {
  return link==1?vibe::Transport::usb:link==2?vibe::Transport::spp:vibe::Transport::none;
}
}
extern "C" {
void gar_app_init() {
  facts.width=gar_board::display::width;facts.height=gar_board::display::height;
  facts.battery=82;facts.sppReady=true;app.begin(facts);app.step();lv_task_handler();
}
void gar_app_tick(unsigned elapsed) {
  lv_tick_inc(elapsed);app.step();lv_task_handler();
}
void gar_app_feed_bytes(int link,const char* bytes,unsigned size) {
  if(bytes)app.feed(transport(link),bytes,size);
}
void gar_app_button(int key,int phase) { app.button(static_cast<char>(key),phase); }
void gar_app_hardware(int powered,int battery,int sppReady,int sppClient) {
  facts.powered=powered!=0;facts.battery=battery;facts.sppReady=sppReady!=0;
  facts.sppClient=sppClient!=0;app.hardware(facts);
}
void gar_app_pairing(unsigned code) { if(code<=999999)app.pairingRequested(code); }
void gar_app_authenticated(int success) { app.authenticated(success!=0); }
void gar_app_transport_reset(int link,int mode) {
  if(mode==1)app.discardTransport(transport(link));else app.resetTransport(transport(link));
}
const char* gar_app_snapshot() { snapshot=app.snapshot();return snapshot.c_str(); }
const char* gar_app_take_output() {
  result.clear();if(!outgoing.empty()) { result=std::move(outgoing.front());outgoing.pop_front(); }
  return result.c_str();
}
}

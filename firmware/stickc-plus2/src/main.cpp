// Product composition: board I/O -> portable application. No pin/driver facts.
#include <Arduino.h>
#include "GarStickCPlus2.h"
#include "DeviceApplication.h"
#include "application_config.h"

namespace {
namespace board = gar::stickc_plus2;
namespace config = gar_application;
vibe::Transport transport(board::Link link) {
  return link==board::Link::usb?vibe::Transport::usb:vibe::Transport::spp;
}
vibe::DeviceApplication::Hardware facts(const board::Hardware& hardware) {
  return {hardware.powered,hardware.sppReady,hardware.sppClient,
          hardware.battery,hardware.width,hardware.height,hardware.board};
}
vibe::DeviceApplication app(
  {config::device,config::firmware,config::bluetooth_name,config::source_prefix},
  [](vibe::Transport link,const std::string& bytes) {
    if(link!=vibe::Transport::none)board::send(link==vibe::Transport::usb?board::Link::usb:board::Link::spp,bytes);
  },board::confirmPairing);
}
void setup() {
  board::begin({config::bluetooth_name,config::rotation,config::brightness},{
    [](board::Link link,const char* bytes,size_t size) {app.feed(transport(link),bytes,size);},
    [](board::Link link,bool discard) {
      if(discard)app.discardTransport(transport(link));else app.resetTransport(transport(link));
    },
    [](char key,int phase) {app.button(key,phase);},
    [](uint32_t number) {app.pairingRequested(number);},
    [](bool success) {app.authenticated(success);},
    [](const board::Hardware& hardware) {app.hardware(facts(hardware));}
  });
  app.begin(facts(board::hardware()));
}
void loop() {board::poll();app.step();lv_task_handler();delay(5);}

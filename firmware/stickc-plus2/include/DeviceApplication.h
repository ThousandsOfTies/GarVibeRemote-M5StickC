#pragma once
#include <functional>
#include <string>
#include "CompactUi.h"
#include "DeviceLink.h"
#include "PairingConsent.h"

namespace stickc {
// Application runtime shared by ESP32 and the PC simulator. The platform owns
// byte transport, LVGL display/clock, battery readings and Bluetooth callbacks.
// It does not interpret application packets or make pairing/choice decisions.
class DeviceApplication {
 public:
  struct Hardware {
    bool powered=true, sppReady=false, sppClient=false;
    int battery=0, width=135, height=240, board=0;
  };
  using Send = std::function<void(Transport,const std::string&)>;
  using ConfirmPairing = std::function<void(bool)>;
  DeviceApplication(Send send,ConfirmPairing confirm);
  void begin(const Hardware& hardware);
  void hardware(const Hardware& hardware);
  void feed(Transport link,const char* bytes,size_t size);
  // An epoch boundary resets a stream and releases its ownership. Overflow
  // instead discards through the next newline, without joining broken frames.
  void resetTransport(Transport link);
  void discardTransport(Transport link);
  void button(char key,int phase);
  void pairingRequested(uint32_t number);
  void authenticated(bool success);
  void step();
  std::string snapshot() const;
 private:
  vibe::CompactUi ui_;
  JsonLines usbLines_,sppLines_;
  DeviceLease lease_;
  PairingConsent pairing_;
  Hardware hardware_;
  Send send_;
  ConfirmPairing confirm_;
  bool pairingScreenVisible_=false;
  unsigned authenticationAttempts_=0;
  int lastAuthentication_=0;
  void updateHardware();
  void send(Transport link,const JsonDocument& document) const;
  void receive(Transport link,const std::string& packet);
  void hello(Transport link) const;
  void pairingInfo(JsonDocument& document) const;
  void pairingScreen(const char* message,bool choices=false);
};
}

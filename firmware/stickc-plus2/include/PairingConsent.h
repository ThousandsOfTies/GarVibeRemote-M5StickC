#pragma once
#include <cstdint>
#include <string>

namespace stickc {
// Main-task state only. Bluetooth callbacks hand off events atomically.
class PairingConsent {
 public:
  void begin(uint32_t now) { ++generation_;started_=now;state_="confirming"; }
  bool active() const { return state_=="confirming" || state_=="verifying"; }
  bool confirming() const { return state_=="confirming"; }
  std::string id() const { return "bluetooth-pair-"+std::to_string(generation_); }
  const char* state() const { return state_.c_str(); }
  bool answer(const std::string& id,bool accept) {
    if(!confirming() || id!=this->id())return false;
    state_=accept?"verifying":"rejected";return true;
  }
  void authenticated(bool ok) {
    if(active())state_=ok?"paired":"failed";
  }
  bool expire(uint32_t now) {
    if(!active() || uint32_t(now-started_)<30000)return false;
    state_="expired";return true;
  }
 private:
  std::string state_="idle";
  uint32_t started_=0,generation_=0;
};
}

#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace stickc {
enum class Transport { none, usb, spp };
inline const char* name(Transport link) {
  return link==Transport::spp ? "bluetooth-spp" : link==Transport::usb ? "usb-serial" : "none";
}
class JsonLines {
 public:
  explicit JsonLines(size_t maximum=65536):maximum_(maximum) { text_.reserve(4096); }
  void reset() { text_.clear();dropping_=false; }
  void discard() { text_.clear();dropping_=true; }
  template<class Receive> void byte(char c,Receive receive) {
    if(c=='\r')return;
    if(c=='\n') {
      if(!dropping_ && !text_.empty())receive(text_);
      reset();
    } else if(!dropping_) {
      if(text_.size()<maximum_)text_+=c;
      else discard();
    }
  }
 private:
  size_t maximum_;
  std::string text_;
  bool dropping_=false;
};

// Only one controller owns the UI. Snapshot/debug traffic never takes ownership.
class DeviceLease {
 public:
  Transport owner() const { return owner_; }
  bool claim(Transport link,uint32_t now) {
    if(owner_!=Transport::none && owner_!=link)return false;
    owner_=link;heartbeat_=now;return true;
  }
  bool renew(Transport link,uint32_t now) {
    if(link!=owner_ || owner_==Transport::none)return false;
    heartbeat_=now;return true;
  }
  bool release(Transport link) {
    if(link!=owner_ || owner_==Transport::none)return false;
    owner_=Transport::none;return true;
  }
  bool expire(uint32_t now) {
    if(owner_!=Transport::none && uint32_t(now-heartbeat_)>8000) {
      owner_=Transport::none;return true;
    }
    return false;
  }
 private:
  Transport owner_=Transport::none;
  uint32_t heartbeat_=0;
};
}

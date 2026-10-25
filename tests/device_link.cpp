#include "DeviceLink.h"
#include "PairingConsent.h"
#include <cassert>
#include <iostream>
#include <vector>
using namespace stickc;
int main() {
  std::vector<std::string> received;
  JsonLines lines(6),other(6);
  auto feed=[&](JsonLines& reader,const std::string& bytes) {
    for(char c:bytes)reader.byte(c,[&](const std::string& s){received.push_back(s);});
  };
  feed(lines,"abc");feed(other,"other\n");feed(lines,"def\r\n");
  assert((received==std::vector<std::string>{"other","abcdef"}));
  feed(lines,"abcdefX\nnext\n");assert(received.back()=="next");assert(received.size()==3);
  feed(lines,"old");lines.discard();feed(lines,"tail\nnew\n");assert(received.back()=="new");assert(received.size()==4);
  DeviceLease lease;
  assert(!lease.renew(Transport::usb,0));assert(lease.claim(Transport::usb,0));
  assert(!lease.claim(Transport::spp,10));assert(!lease.renew(Transport::spp,7999));
  assert(!lease.expire(8000));assert(lease.expire(8001));assert(lease.owner()==Transport::none);
  assert(lease.claim(Transport::spp,9000));assert(!lease.release(Transport::usb));assert(lease.release(Transport::spp));
  assert(lease.claim(Transport::usb,0xfffffff0));assert(!lease.expire(uint32_t(0xfffffff0+8000ULL)));
  assert(lease.expire(uint32_t(0xfffffff0+8001ULL)));
  PairingConsent pairing;
  assert(!pairing.active());assert(!pairing.answer("old",true));
  pairing.begin(100);const auto first=pairing.id();assert(pairing.confirming());
  assert(!pairing.answer("old",true));assert(pairing.answer(first,true));assert(!pairing.confirming());
  assert(!pairing.answer(first,true));pairing.authenticated(true);assert(!pairing.active());
  assert(std::string(pairing.state())=="paired");
  pairing.begin(200);assert(pairing.id()!=first);assert(!pairing.answer(first,true));
  assert(pairing.answer(pairing.id(),false));pairing.authenticated(false);
  assert(std::string(pairing.state())=="rejected");
  pairing.begin(0xfffffff0);assert(!pairing.expire(uint32_t(0xfffffff0+29999ULL)));
  assert(pairing.expire(uint32_t(0xfffffff0+30000ULL)));assert(!pairing.answer(pairing.id(),true));
  pairing.begin(300);pairing.authenticated(false);assert(std::string(pairing.state())=="failed");
  std::cout<<"PASS: framing, ownership/lease, explicit pairing consent, stale reply rejection, timeout/wrap\n";
}

import { textVault } from './vault.mjs';
import { reject } from './providers.mjs';

// Only the two verified contact fields enter this envelope. The member binding
// prevents an encrypted contact from being moved onto another identity.
export function contactVault(secret){
  const vault=textVault(secret,'paperchat/contact/v1');
  function seal(customer,identity) {
    const name=typeof customer?.name==='string'?customer.name.trim():'';
    const digits=String(customer?.phoneNumber||'').replace(/[\s()-]/g,'').replace(/^\+82/,'0');
    if(!name || name.length>120 || !/^01\d{8,9}$/.test(digits))
      reject(422,'인증기관에서 이름 또는 휴대폰번호를 확인하지 못했어요. 관리자는 다날 전화번호 제공 설정을 확인해 주세요.');
    return vault.seal(JSON.stringify({name,phone:digits}),identity);
  }
  function read(blob,identity){
    return blob ? JSON.parse(vault.open(blob,identity)) : null;
  }
  return {seal,read};
}

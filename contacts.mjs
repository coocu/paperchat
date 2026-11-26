import { createCipheriv,createDecipheriv,createHmac,randomBytes } from 'node:crypto';
import { reject } from './providers.mjs';

// Only the two verified contact fields enter this envelope. The member binding
// prevents an encrypted contact from being moved onto another identity.
export function contactVault(secret){
  const key=createHmac('sha256',secret).update('paperchat/contact/v1').digest();
  function seal(customer,identity) {
    const name=typeof customer?.name==='string'?customer.name.trim():'';
    const digits=String(customer?.phoneNumber||'').replace(/[\s()-]/g,'').replace(/^\+82/,'0');
    if(!name || name.length>120 || !/^01\d{8,9}$/.test(digits))
      reject(422,'인증기관에서 이름 또는 휴대폰번호를 확인하지 못했어요. 관리자는 다날 전화번호 제공 설정을 확인해 주세요.');
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(Buffer.from(identity));
    const text=Buffer.concat([cipher.update(JSON.stringify({name,phone:digits}),'utf8'),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),text]);
  }
  function read(blob,identity){
    if(!blob)return null;
    const b=Buffer.from(blob),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));
    d.setAAD(Buffer.from(identity));d.setAuthTag(b.subarray(12,28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'));
  }
  return {seal,read};
}

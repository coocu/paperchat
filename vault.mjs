import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// Each kind of data gets its own key. A sealed value belongs to one owner.
export function textVault(secret, purpose) {
  const key=createHmac('sha256',secret).update(purpose).digest();
  function seal(text,owner) {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(Buffer.from(owner));
    const data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),data]);
  }
  function open(value,owner) {
    const bytes=Buffer.from(value),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(owner));
    decipher.setAuthTag(bytes.subarray(12,28));
    return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
  }
  return {seal,open};
}

import { textVault } from './vault.mjs';

// Previously verified records remain readable in the administrator console.
export function contactVault(secret){
  const vault=textVault(secret,'paperchat/contact/v1');
  return {read(blob,identity){
    return blob ? JSON.parse(vault.open(blob,identity)) : null;
  }};
}

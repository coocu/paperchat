import { readFileSync, existsSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';

function readSetting(name, load) {
  try { return load(); }
  catch {
    // JSON and crypto parser messages may include parts of private keys.
    console.warn('푸시 설정을 확인해 주세요:',name);
    return null;
  }
}

function valueOrFile(value,path) {
  const text=value?.trim();
  if (text) return text;
  return existsSync(path) ? readFileSync(path,'utf8') : null;
}

function privateKey(pem,kind) {
  const key=createPrivateKey(pem.replace(/\\n/g,'\n'));
  if (key.asymmetricKeyType!==kind || (kind==='ec' && key.asymmetricKeyDetails?.namedCurve!=='prime256v1'))
    throw new Error('Unexpected key type');
  return key;
}

export function pushSettings(env) {
  const google=readSetting('FCM_SERVICE_ACCOUNT_JSON',()=>{
    const value=valueOrFile(env.FCM_SERVICE_ACCOUNT_JSON,env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/firebase-service-account.json');
    if (!value) return null;
    const {project_id,client_email,private_key}=JSON.parse(value);
    if (typeof project_id!=='string' || !project_id.trim() || typeof client_email!=='string' || !client_email.includes('@')) throw new Error();
    return {project_id,client_email,key:privateKey(private_key,'rsa')};
  });

  const android=readSetting('FIREBASE_ANDROID_CONFIG_JSON',()=>{
    if (!env.FIREBASE_ANDROID_CONFIG_JSON?.trim()) return null;
    const config=JSON.parse(env.FIREBASE_ANDROID_CONFIG_JSON);
    const {project_id:projectId,project_number:senderId}=config.project_info;
    const client=config.client.find(c=>c.client_info?.android_client_info?.package_name==='com.codenote.paperchat');
    const appId=client?.client_info?.mobilesdk_app_id;
    const apiKey=client?.api_key?.find(k=>typeof k.current_key==='string' && /^A[\w-]{38}$/.test(k.current_key))?.current_key;
    if (!apiKey || !/^\d+$/.test(senderId) || typeof senderId!=='string' || !projectId || typeof projectId!=='string' ||
        typeof appId!=='string' || !appId.startsWith('1:'+senderId+':android:') || (google && google.project_id!==projectId)) throw new Error();
    // The native client only needs these four public fields. Never return the input JSON.
    return {appId,senderId,projectId,apiKey};
  });

  function appleCredentials(name,id,pem,path) {
    return readSetting(name,()=>{
      if (!env.APNS_TEAM_ID || !id) return null;
      const value=valueOrFile(pem,path);
      return value ? {id,key:privateKey(value,'ec'),cached:null} : null;
    });
  }
  const apple=appleCredentials('APNS_PRIVATE_KEY',env.APNS_KEY_ID,env.APNS_PRIVATE_KEY,env.APNS_KEY_PATH || '/etc/secrets/apns.p8');
  const development=env.APNS_DEV_KEY_ID || env.APNS_DEV_PRIVATE_KEY || env.APNS_DEV_KEY_PATH
    ? appleCredentials('APNS_DEV_PRIVATE_KEY',env.APNS_DEV_KEY_ID,env.APNS_DEV_PRIVATE_KEY,env.APNS_DEV_KEY_PATH || '/etc/secrets/apns-dev.p8')
    : apple;
  return {google,android,apple,development,androidMismatch:Boolean(env.FIREBASE_ANDROID_CONFIG_JSON?.trim() && !android)};
}

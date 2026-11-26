export class RequestError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}
export function reject(status, message) { throw new RequestError(status,message); }

async function remote(url, options) {
  try {
    const r=await fetch(url,{...options, signal:AbortSignal.timeout(12000),redirect:'error'});
    if (!r.ok) reject(502,'인증기관에서 결과를 확인하지 못했어요. 다시 시도해 주세요.');
    return await r.json();
  } catch (e) {
    if (e instanceof RequestError) throw e;
    reject(503,'인증 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
}
export const providers = {
  async check(code) {
    const endpoint=process.env.KEY_CHECK_URL || 'https://poketserver.onrender.com/app/check';
    if (new URL(endpoint).protocol!=='https:') reject(503,'인증 서버 주소를 확인해 주세요.');
    return remote(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
  },
  async verify(id,store) {
    const secret=process.env.PORTONE_API_SECRET;
    if (!secret) reject(503,'통신사 인증이 아직 연결되지 않았어요.');
    const url=new URL('https://api.portone.io/identity-verifications/'+encodeURIComponent(id));
    url.searchParams.set('storeId',store);
    return remote(url,{
      headers:{Authorization:'PortOne '+secret}
    });
  }
};
export function adultInfo(v, today=new Date(Date.now()+9*3600000).toISOString().slice(0,10)) {
  const c=v?.verifiedCustomer;
  if (v?.status!=='VERIFIED' || !c?.di || !['MALE','FEMALE'].includes(c.gender))
    reject(403,'통신사가 확인한 본인 정보가 필요해요.');
  const birth=c.birthDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) reject(403,'생년월일을 확인할 수 없어요.');
  const date=new Date(birth+'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==birth)
    reject(403,'생년월일을 확인할 수 없어요.');
  const year=Number(birth.slice(0,4));
  const age=Number(today.slice(0,4))-year-(today.slice(5)<birth.slice(5)?1:0);
  if (age<19) reject(403,'만 19세 생일부터 가입할 수 있어요.');
  return {di:c.di,year,gender:c.gender==='MALE'?'남성':'여성'};
}

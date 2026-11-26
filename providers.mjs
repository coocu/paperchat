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
  }
};

export function profileDetails(input, now=Date.now()) {
  const birthDate = input.birthDate;
  if (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate))
    reject(400,'생년월일을 입력해 주세요.');
  const calendarDate = new Date(birthDate + 'T00:00:00Z');
  const today = new Date(now + 9 * 3600_000).toISOString().slice(0,10);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0,10) !== birthDate ||
      birthDate < '1900-01-01' || birthDate > today)
    reject(400,'올바른 생년월일을 입력해 주세요.');
  const year = calendarDate.getUTCFullYear();
  const age = Number(today.slice(0,4)) - year - (today.slice(5) < birthDate.slice(5) ? 1 : 0);
  if (age < 19) reject(403,'만 19세 생일부터 가입할 수 있어요.');
  if (!['남성','여성'].includes(input.gender))
    reject(400,'성별을 선택해 주세요.');
  return {year, gender:input.gender};
}

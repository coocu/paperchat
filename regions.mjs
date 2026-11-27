import {readFileSync} from 'node:fs';

export const regions=JSON.parse(readFileSync(new URL('./regions.json',import.meta.url)));
const legacy=JSON.parse(readFileSync(new URL('./legacy-regions.json',import.meta.url)));
export const canonicalAreas=new Set(Object.entries(regions).flatMap(([region,zones])=>zones.map(zone=>region+' '+zone)));

// These are service areas for profile discovery, not administrative boundaries.
// Keeping the old catalog private to the server allows existing accounts and
// already-open older clients to move to wider areas without losing their data.
const aliases={
  서울특별시:'서울',경기도:'경기',부산광역시:'부산',대구광역시:'대구',인천광역시:'인천',
  광주광역시:'광주',대전광역시:'대전',울산광역시:'울산',세종특별자치시:'세종',
  강원특별자치도:'강원',강원도:'강원',충청북도:'충북',충청남도:'충남',
  전북특별자치도:'전북',전라북도:'전북',전라남도:'전남',경상북도:'경북',경상남도:'경남',제주특별자치도:'제주',제주도:'제주'
};
const seoulZones={
  동부:['성동구','광진구','동대문구','중랑구','강동구'],
  서부:['마포구','서대문구','은평구','강서구','양천구'],
  남부:['강남구','서초구','송파구','동작구','관악구','영등포구','구로구','금천구'],
  북부:['강북구','성북구','도봉구','노원구'],
  중부:['종로구','중구','용산구']
};
const northGyeonggi=new Set(['가평군','고양시','구리시','남양주시','동두천시','양주시','연천군','의정부시','파주시','포천시']);
const gwangjuDistricts=new Set(['광산구','남구','동구','북구','서구']);
const accepted=new Map();
function remember(area,target){accepted.set(area,target);}
for(const [province,districts] of Object.entries(legacy)){
  for(const district of districts){
    const city=district.split(' ')[0];
    const region=province==='전남광주통합특별시'?(gwangjuDistricts.has(city)?'광주':'전남'):aliases[province];
    const zone=region==='서울'?Object.entries(seoulZones).find(([,items])=>items.includes(district))?.[0]:
      region==='경기'?(northGyeonggi.has(city)?'북부':'남부'):'전체';
    const target=region+' '+zone;
    if(!canonicalAreas.has(target))throw new Error('기존 지역의 권역 변환을 확인하세요: '+province+' '+district);
    const provinceNames=[province,region,...Object.keys(aliases).filter(key=>aliases[key]===region)];
    for(const name of provinceNames){remember(name+' '+district,target);remember(name+' '+city,target);}
  }
}
// Historical city names used before the current district catalog.
for(const district of ['동구','중구'])for(const name of ['인천','인천광역시'])remember(name+' '+district,'인천 전체');
for(const [alias,region] of Object.entries(aliases))for(const zone of regions[region])remember(alias+' '+zone,region+' '+zone);

export function normalizeArea(value){
  if(typeof value!=='string')return null;
  const area=value.trim().replace(/\s+/g,' ');
  return canonicalAreas.has(area)?area:accepted.get(area)||null;
}

// The caller wraps this migration in the same transaction as schema updates.
// Unknown historical values are not assigned to an arbitrary nearby region.
export function migrateMemberAreas(db){
  const update=db.prepare('UPDATE members SET area=? WHERE area=?');
  let changed=0;
  for(const row of db.prepare('SELECT DISTINCT area FROM members').all()){
    const area=normalizeArea(row.area)||'지역 미선택';
    if(area!==row.area)changed+=Number(update.run(area,row.area).changes);
  }
  return changed;
}

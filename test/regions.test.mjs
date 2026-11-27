import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {regions,canonicalAreas,normalizeArea,migrateMemberAreas} from '../regions.mjs';

test('모든 기존 지역은 세부 주소를 노출하지 않는 22개 서비스 권역으로 변환된다',()=>{
  assert.equal(Object.keys(regions).length,17);
  assert.equal(canonicalAreas.size,22);
  const legacy=JSON.parse(readFileSync(new URL('../legacy-regions.json',import.meta.url)));
  for(const [province,districts] of Object.entries(legacy))for(const district of districts){
    const value=normalizeArea(province+' '+district);
    assert.ok(canonicalAreas.has(value),province+' '+district);
    assert.match(value,/^(서울 (동부|서부|남부|북부|중부)|경기 (남부|북부)|\S+ 전체)$/);
  }
  for(const value of canonicalAreas)assert.equal(normalizeArea(value),value);
});

test('서울·경기와 과거 행정 명칭은 같은 권역을 가리키며 알 수 없는 입력은 거절한다',()=>{
  const samples={
    '서울특별시 마포구':'서울 서부','서울특별시 강동구':'서울 동부','서울특별시 도봉구':'서울 북부',
    '서울특별시 강남구':'서울 남부','서울특별시 종로구':'서울 중부',
    '경기도 고양시 일산서구':'경기 북부','경기도 가평군':'경기 북부','경기도 김포시':'경기 남부',
    '경기도 화성시 동탄구':'경기 남부','경기도 수원시':'경기 남부',
    '강원도 춘천시':'강원 전체','전라북도 전주시 완산구':'전북 전체',
    '광주광역시 광산구':'광주 전체','전라남도 여수시':'전남 전체',
    '전남광주통합특별시 남구':'광주 전체','전남광주통합특별시 목포시':'전남 전체',
    '인천광역시 중구':'인천 전체','  경기   북부  ':'경기 북부','서울특별시 동부':'서울 동부'
  };
  for(const [input,wanted] of Object.entries(samples))assert.equal(normalizeArea(input),wanted,input);
  for(const value of [null,{},123,'','서울특별시 없는구','경기 남부 추가주소','지역 미선택','서울'])assert.equal(normalizeArea(value),null);
});

test('회원 지역 이관은 반복해도 안전하고 미상 값을 추정하지 않으며 프로필 원문을 보존한다',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE members(id TEXT PRIMARY KEY,area TEXT,nick TEXT,year INTEGER,gender TEXT,memo TEXT,deleted_at INTEGER)');
  const insert=db.prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?)');
  insert.run('a','경기도 고양시 덕양구','가',1994,'여성','소개 A',null);
  insert.run('b','서울특별시 강동구','나',1991,'남성','소개 B',123);
  insert.run('c','알 수 없는 예전 지역','다',1996,'여성','소개 C',null);
  insert.run('d','부산 전체','라',1988,'남성','소개 D',null);
  const before=db.prepare('SELECT id,nick,year,gender,memo,deleted_at FROM members ORDER BY id').all();
  assert.equal(migrateMemberAreas(db),3);assert.equal(migrateMemberAreas(db),0);
  assert.deepEqual(db.prepare('SELECT area FROM members ORDER BY id').all().map(r=>r.area),['경기 북부','서울 동부','지역 미선택','부산 전체']);
  assert.deepEqual(db.prepare('SELECT id,nick,year,gender,memo,deleted_at FROM members ORDER BY id').all(),before);
});

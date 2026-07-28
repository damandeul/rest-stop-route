#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Download and profile the full MOIS heat-shelter dataset. Never logs the key."""
from __future__ import annotations
import csv,hashlib,json,math,os,tempfile,time,urllib.parse,urllib.request
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path
from zoneinfo import ZoneInfo
ROOT=Path(os.environ.get('REST_ROUTE_ROOT', str(Path(__file__).resolve().parents[1])))
ENV_FILE=ROOT/'.secrets/safetydata.env'
ENDPOINT='https://www.safetydata.go.kr/V2/api/DSSP-IF-10942'
RAW=ROOT/'data/raw/heat-shelters-full.json'
NORM=ROOT/'data/processed/heat-shelters.jsonl'
REPORT=ROOT/'reports/heat-shelter-profile.md'
PAGE_SIZE=10000
PROVINCES={'11':'서울특별시','12':'전남광주통합특별시','26':'부산광역시','27':'대구광역시','28':'인천광역시','30':'대전광역시','31':'울산광역시','36':'세종특별자치시','41':'경기도','43':'충청북도','44':'충청남도','47':'경상북도','48':'경상남도','50':'제주특별자치도','51':'강원특별자치도','52':'전북특별자치도'}
def key():
 for raw in ENV_FILE.read_text().splitlines():
  if raw.startswith('SAFETYDATA_SERVICE_KEY=') and raw.split('=',1)[1].strip():return raw.split('=',1)[1].strip()
 raise RuntimeError('service key missing')
def fetch(page,rows,service_key):
 params={'serviceKey':service_key,'returnType':'json','pageNo':str(page),'numOfRows':str(rows)}
 req=urllib.request.Request(ENDPOINT+'?'+urllib.parse.urlencode(params),headers={'User-Agent':'rest-route-data-profiler/1.0'})
 last=None
 for attempt in range(4):
  try:
   with urllib.request.urlopen(req,timeout=90) as r:data=json.loads(r.read().decode('utf-8-sig'))
   h=data.get('header') or {}
   if str(h.get('resultCode'))!='00':raise RuntimeError('API result code not normal')
   return data
  except Exception as e:
   last=e
   if attempt==3:break
   time.sleep(2**attempt)
 raise RuntimeError(f'API page fetch failed: {type(last).__name__}')
def atomic_json(path,obj):
 path.parent.mkdir(parents=True,exist_ok=True)
 with tempfile.NamedTemporaryFile('w',encoding='utf-8',dir=path.parent,delete=False) as f:
  json.dump(obj,f,ensure_ascii=False,separators=(',',':'));f.write('\n');tmp=Path(f.name)
 os.replace(tmp,path)
def tri_count(v):
 if v is None or v=='':return 'unknown'
 try:return 'true' if float(v)>0 else 'false'
 except Exception:return 'unknown'
def valid_coord(r):
 try:lat=float(r.get('LA'));lon=float(r.get('LO'));return 32<=lat<=39.5 and 124<=lon<=132
 except Exception:return False
def parse_dt(s):
 if not s:return None
 try:return datetime.strptime(str(s).split('.')[0],'%Y-%m-%d %H:%M:%S').replace(tzinfo=ZoneInfo('Asia/Seoul'))
 except Exception:return None
def province(r):
 code=str(r.get('ARCD') or '')[:2]
 return PROVINCES.get(code,'미분류')
def main():
 started=datetime.now(timezone.utc);service_key=key();first=fetch(1,PAGE_SIZE,service_key);total=int(first.get('totalCount') or 0)
 actual_page_size=int(first.get('numOfRows') or len(first.get('body') or []) or PAGE_SIZE)
 records=list(first.get('body') or []);pages=math.ceil(total/actual_page_size)
 for page in range(2,pages+1):records.extend(fetch(page,PAGE_SIZE,service_key).get('body') or [])
 if len(records)!=total:raise RuntimeError(f'record count mismatch expected={total} actual={len(records)}')
 ingested=datetime.now(timezone.utc).isoformat();raw={'source':ENDPOINT,'retrieved_at':ingested,'declared_total_count':total,'requested_page_size':PAGE_SIZE,'actual_page_size':actual_page_size,'pages':pages,'body':records}
 atomic_json(RAW,raw);raw_sha=hashlib.sha256(RAW.read_bytes()).hexdigest()
 NORM.parent.mkdir(parents=True,exist_ok=True)
 with tempfile.NamedTemporaryFile('w',encoding='utf-8',dir=NORM.parent,delete=False) as f:
  for r in records:
   n={'place_id':f"mois-heat-{r.get('RSTR_FCLTY_NO')}",'source_id':'mois_heat_shelter','source_url':'https://www.safetydata.go.kr/disaster-data/view?dataSn=1338','source_provider':'행정안전부','original_id':r.get('RSTR_FCLTY_NO'),'name':r.get('RSTR_NM'),'category':'cooling_shelter','lat':r.get('LA'),'lon':r.get('LO'),'coordinate_source':'official_api','coordinate_precision':'provided_unknown','road_address':r.get('RN_DTL_ADRES'),'lot_address':r.get('DTL_ADRES'),'weekday_begin':r.get('WKDAY_OPER_BEGIN_TIME'),'weekday_end':r.get('WKDAY_OPER_END_TIME'),'weekend_begin':r.get('WKEND_HDAY_OPER_BEGIN_TIME'),'weekend_end':r.get('WKEND_HDAY_OPER_END_TIME'),'weekend_open':r.get('CHCK_MATTER_WKEND_HDAY_OPN_AT'),'has_aircon':tri_count(r.get('COLR_HOLD_ARCNDTN')),'aircon_count':r.get('COLR_HOLD_ARCNDTN'),'has_fan':tri_count(r.get('COLR_HOLD_ELEFN')),'fan_count':r.get('COLR_HOLD_ELEFN'),'capacity':r.get('USE_PSBL_NMPR'),'record_updated_at':r.get('MODF_TIME'),'ingested_at':ingested,'province':province(r),'raw':r}
   f.write(json.dumps(n,ensure_ascii=False,separators=(',',':'))+'\n')
  tmp=Path(f.name)
 os.replace(tmp,NORM)
 fields=sorted({k for r in records for k in r})
 miss={k:sum(r.get(k) is None or r.get(k)=='' for r in records) for k in fields}
 ids=[r.get('RSTR_FCLTY_NO') for r in records if r.get('RSTR_FCLTY_NO') is not None]
 keydups=Counter((r.get('RSTR_NM'),r.get('RN_DTL_ADRES')) for r in records)
 now=datetime.now(ZoneInfo('Asia/Seoul'));dates=[d for r in records if (d:=parse_dt(r.get('MODF_TIME')))]
 byprov=Counter(province(r) for r in records)
 coords=sum(valid_coord(r) for r in records);wk=sum(bool(r.get('WKDAY_OPER_BEGIN_TIME')) and bool(r.get('WKDAY_OPER_END_TIME')) for r in records);we=sum(bool(r.get('WKEND_HDAY_OPER_BEGIN_TIME')) and bool(r.get('WKEND_HDAY_OPER_END_TIME')) for r in records)
 air=Counter(tri_count(r.get('COLR_HOLD_ARCNDTN')) for r in records);fan=Counter(tri_count(r.get('COLR_HOLD_ELEFN')) for r in records)
 recent30=sum((now-d).days<=30 for d in dates);recent365=sum((now-d).days<=365 for d in dates)
 def pct(n):return f'{n/total*100:.2f}%'
 lines=['# 행정안전부 무더위쉼터 API 전량 프로파일','',f'- 수집 시각(UTC): {ingested}',f'- 공식 엔드포인트: `{ENDPOINT}`',f'- 원문: https://www.safetydata.go.kr/disaster-data/view?dataSn=1338',f'- API 응답 totalCount: **{total:,}건**',f'- 실제 수집: **{len(records):,}건 / {pages}페이지**',f'- 원본 SHA-256: `{raw_sha}`','- 키는 보고서·원본·정규화 파일에 저장하지 않음','', '## 핵심 품질 결과','',f'- 공식 위·경도 유효: **{coords:,}건 ({pct(coords)})**',f'- 평일 시작·종료시간 모두 있음: **{wk:,}건 ({pct(wk)})**',f'- 주말 시작·종료시간 모두 있음: **{we:,}건 ({pct(we)})**',f'- 냉방기: true {air["true"]:,} / false {air["false"]:,} / unknown {air["unknown"]:,}',f'- 선풍기: true {fan["true"]:,} / false {fan["false"]:,} / unknown {fan["unknown"]:,}',f'- 수정시각 파싱 가능: **{len(dates):,}건 ({pct(len(dates))})**',f'- 최근 30일 이내 수정: **{recent30:,}건 ({pct(recent30)})**',f'- 최근 365일 이내 수정: **{recent365:,}건 ({pct(recent365)})**',f'- 원본 ID 중복 추가행: **{len(ids)-len(set(ids)):,}건**',f'- 동일 이름+도로명주소 중복 추가행: **{sum(n-1 for n in keydups.values() if n>1):,}건**','', '## API 광역 행정단위(16개)별 건수','', '| 광역단위 | 건수 | 비율 |','|---|---:|---:|']
 for name in list(PROVINCES.values())+['미분류']:
  n=byprov[name];lines.append(f'| {name} | {n:,} | {pct(n)} |')
 lines+=['','## 주요 필드 결측','', '| 필드 | 결측 건수 | 결측률 |','|---|---:|---:|']
 for k in ['RSTR_FCLTY_NO','RSTR_NM','RN_DTL_ADRES','DTL_ADRES','LA','LO','WKDAY_OPER_BEGIN_TIME','WKDAY_OPER_END_TIME','WKEND_HDAY_OPER_BEGIN_TIME','WKEND_HDAY_OPER_END_TIME','CHCK_MATTER_WKEND_HDAY_OPN_AT','COLR_HOLD_ARCNDTN','COLR_HOLD_ELEFN','USE_PSBL_NMPR','MODF_TIME']:
  n=miss.get(k,total);lines.append(f'| `{k}` | {n:,} | {pct(n)} |')
 lines+=['','## 판정','', '- 이 결과는 전국 API **전량 수집 성공**과 현재 스냅샷의 품질을 뜻한다. 모든 지역·모든 시설의 완전성이나 당일 운영·냉방 작동을 보장하지 않는다.','- `unknown`은 `false`로 바꾸지 않는다. 냉방 여부가 unknown인 장소는 냉방 조건 경로 연결점으로 사용하지 않는다.','- 공식 좌표가 유효하더라도 운영시간·접근조건·수정일 하드 게이트를 별도로 적용한다.','- 현재 API의 광역단위 건수는 전남광주통합특별시를 포함한 16개 코드 분포이며 시설 누락이 없다는 증거가 아니다.','', '## 산출물','',f'- 원본: `{RAW}`',f'- 정규화 JSONL: `{NORM}`',f'- 본 보고서: `{REPORT}`','']
 REPORT.parent.mkdir(parents=True,exist_ok=True);REPORT.write_text('\n'.join(lines),encoding='utf-8')
 print(json.dumps({'ok':True,'total':total,'pages':pages,'valid_coords':coords,'raw_sha256':raw_sha,'raw':str(RAW),'normalized':str(NORM),'report':str(REPORT),'elapsed_seconds':round((datetime.now(timezone.utc)-started).total_seconds(),2)},ensure_ascii=False))
if __name__=='__main__':main()

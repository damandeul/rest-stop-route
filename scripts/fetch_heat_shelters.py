#!/usr/bin/env python3
"""Fetch a page from the MOIS heat-shelter API without logging the API key."""
from __future__ import annotations
import argparse,json,os,tempfile,urllib.parse,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ENV_FILE=ROOT/'.secrets/safetydata.env'
ENDPOINT='https://www.safetydata.go.kr/V2/api/DSSP-IF-10942'
def load_key()->str:
    for raw in ENV_FILE.read_text().splitlines():
        if raw.startswith('SAFETYDATA_SERVICE_KEY='):
            value=raw.split('=',1)[1].strip()
            if value:return value
    raise RuntimeError('service key missing')
def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--page',type=int,default=1)
    ap.add_argument('--rows',type=int,default=5)
    ap.add_argument('--output',type=Path,required=True)
    a=ap.parse_args()
    if a.page<1 or not 1<=a.rows<=10000:raise SystemExit('invalid page/rows')
    params={'serviceKey':load_key(),'returnType':'json','pageNo':str(a.page),'numOfRows':str(a.rows)}
    req=urllib.request.Request(ENDPOINT+'?'+urllib.parse.urlencode(params),headers={'User-Agent':'rest-route-data-profiler/1.0'})
    with urllib.request.urlopen(req,timeout=60) as r:
        body=r.read();status=r.status;ctype=r.headers.get_content_type()
    if status!=200:raise RuntimeError(f'HTTP {status}')
    data=json.loads(body.decode('utf-8-sig'))
    a.output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile('w',encoding='utf-8',dir=a.output.parent,delete=False) as f:
        json.dump(data,f,ensure_ascii=False,indent=2);f.write('\n');tmp=Path(f.name)
    os.replace(tmp,a.output)
    top=list(data) if isinstance(data,dict) else []
    print(json.dumps({'ok':True,'http_status':status,'content_type':ctype,'top_keys':top,'output':str(a.output)},ensure_ascii=False))
if __name__=='__main__':main()

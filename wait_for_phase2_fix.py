#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json,subprocess,time
TASK='t_e917f2d3';BOARD='damandeul-company'
for _ in range(1080):
    subprocess.run(['hermes','kanban','--board',BOARD,'dispatch'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    p=subprocess.run(['hermes','kanban','--board',BOARD,'show',TASK,'--json'],capture_output=True,text=True)
    if p.returncode==0:
        try:
            payload=json.loads(p.stdout);task=payload.get('task',payload);status=task.get('status')
            if status=='blocked':
                print('REST_ROUTE_PHASE2_FIX_REVIEW_REQUIRED task='+TASK,flush=True);raise SystemExit(0)
            if status=='done':
                print('REST_ROUTE_PHASE2_FIX_DONE task='+TASK,flush=True);raise SystemExit(0)
        except json.JSONDecodeError:pass
    time.sleep(10)
print('REST_ROUTE_PHASE2_FIX_MONITOR_TIMEOUT task='+TASK,flush=True);raise SystemExit(3)

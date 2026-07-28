#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json,subprocess,time
TASK='t_968e099f'
BOARD='damandeul-company'
for _ in range(1080):
    subprocess.run(['hermes','kanban','--board',BOARD,'dispatch'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    p=subprocess.run(['hermes','kanban','--board',BOARD,'show',TASK,'--json'],capture_output=True,text=True)
    if p.returncode==0:
        try:
            payload=json.loads(p.stdout);task=payload.get('task',payload);status=task.get('status')
            if status=='done':
                print('REST_ROUTE_PHASE2_READY /Users/damandeul/다만들/ai-company/public-app-ideas/rest-stop-route/PHASE_2_REPORT.md',flush=True);raise SystemExit(0)
            if status=='blocked':
                print('REST_ROUTE_PHASE2_BLOCKED task='+TASK,flush=True);raise SystemExit(2)
        except json.JSONDecodeError:
            pass
    time.sleep(10)
print('REST_ROUTE_PHASE2_MONITOR_TIMEOUT task='+TASK,flush=True);raise SystemExit(3)

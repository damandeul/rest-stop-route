#!/usr/bin/env python3
import json,subprocess,time,sys
TASK='t_d29b3947'; BOARD='damandeul-company'; DEADLINE=time.time()+10800
while time.time()<DEADLINE:
 p=subprocess.run(['hermes','kanban','--board',BOARD,'show',TASK,'--json'],text=True,capture_output=True)
 if p.returncode==0:
  try: status=json.loads(p.stdout).get('task',{}).get('status')
  except Exception: status=None
  if status=='done':
   print('REST_ROUTE_PHASE1_READY /Users/damandeul/다만들/ai-company/public-app-ideas/rest-stop-route/PHASE_1_REPORT.md')
   sys.exit(0)
  if status in {'blocked','archived'}:
   print('REST_ROUTE_PHASE1_NEEDS_REVIEW status='+str(status))
   sys.exit(2)
 time.sleep(20)
print('REST_ROUTE_PHASE1_TIMEOUT task='+TASK)
sys.exit(3)

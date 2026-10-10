"""Generate reproducible PR details seed from locally downloaded Google Sheet export."""
import openpyxl,re,json,sys
from datetime import datetime
from pathlib import Path
root=Path(__file__).resolve().parents[1]
src=Path(sys.argv[1] if len(sys.argv)>1 else root.parent/'PR_Outstanding_List_20260911_MS.xlsx')
master=set(re.findall(r"\('((?:12|15)\d{3})',",(root/'supabase/seed.sql').read_text()))
ws=openpyxl.load_workbook(src,read_only=True,data_only=True).active
val=lambda v: '' if v is None else str(v).strip()
date=lambda v: v.strftime('%d/%m/%Y') if isinstance(v,datetime) else val(v)
def num(v):
 if v is None or v=='':return None
 try:return float(str(v).replace(',','.'))
 except:return None
rows=[];allrows=0
for idx,r in enumerate(ws.values,1):
 if idx<=10 or not r[4] or not r[9] or not isinstance(r[5],(float,int)):continue
 allrows+=1
 if val(r[9]) not in master:continue
 rows.append(dict(code=val(r[9]),source_key='goods-issued-status-2026',source_row=idx,year=2026,
 slip_no=val(r[4]),line_no=int(r[5]),pr_date=date(r[6]),order_cost_center=val(r[0]),cost_center=val(r[1]),
 account_code=val(r[2]),activity_code=val(r[3]),requestor=val(r[20]),description=val(r[10]),specification=val(r[11]),
 budget_no=val(r[7]),project_no=val(r[8]),quantity=num(r[12]),uom=val(r[13]),amount=num(r[14]),outstanding_amount=num(r[15]),
 sap_ref=val(r[16]),sap_date=date(r[17]),sap_qty=num(r[18]),sap_amount=num(r[19])))
cols=[k for k in rows[0] if k!='code']
parts=['-- Seed for 57 current master items; generated from PR Outstanding List.\n-- Run 003_pr_details.sql first. Re-running safely updates by source_key + source_row.\n']
for i in range(0,len(rows),200):
 chunk=rows[i:i+200]
 data=json.dumps(chunk,ensure_ascii=False,allow_nan=False).replace("'","''")
 parts.append(f"""insert into public.pr_details(item_id,{','.join(cols)})
select i.id,{','.join('r.'+c for c in cols)}
from jsonb_to_recordset('{data}'::jsonb) as r(code text,{','.join(c+' '+('integer' if c in ('source_row','year','line_no') else 'numeric' if c in ('quantity','amount','outstanding_amount','sap_qty','sap_amount') else 'text') for c in cols)})
join public.items i on i.code=r.code
on conflict(source_key,source_row) do update set {','.join(c+'=excluded.'+c for c in ['item_id']+cols if c not in ('source_key','source_row'))};
""")
(root/'supabase/seed_pr_details.sql').write_text('\n'.join(parts))
print(f'PR rows {allrows}; matched current master {len(rows)}; items {len(set(r["code"] for r in rows))}; seed written')

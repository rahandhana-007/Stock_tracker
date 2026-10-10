/* Pure Budget System dashboard aggregates: PR enriches SAP, never changes stock. */
(function(){
  "use strict";
  const label=v=>String(v||"").trim()||"Tidak disebutkan";
  const key=(id,ref)=>`${id}|${ref}`;
  function build(pr,so,items){
    const master=new Map(items.map(x=>[Number(x.id),x]));
    const soByRef=new Map();
    for(const r of so){const ref=String(r.doc_no||"").match(/\d+/)?.[0];if(ref&&!soByRef.has(key(r.item_id,ref)))soByRef.set(key(r.item_id,ref),r);}
    const rows=pr.filter(r=>master.has(Number(r.item_id))).map(p=>{
      const it=master.get(Number(p.item_id));const posting=p.sap_ref?soByRef.get(key(p.item_id,p.sap_ref)):null;
      return {...p,code:it.code,item_description:it.description,category:it.category,stock_status:it.calc?.status||"none",
        posting_date:posting?.posting_date||null,linked:!!posting,amount_num:Number(p.amount)||0,qty_num:Number(p.quantity)||0};
    });
    const group=(field)=>{
      const map=new Map();
      for(const r of rows){const k=label(r[field]);if(!map.has(k))map.set(k,{name:k,lines:0,slips:new Set(),items:new Set(),amount:0,linked:0});const x=map.get(k);x.lines++;x.slips.add(r.slip_no);x.items.add(r.item_id);x.amount+=r.amount_num;if(r.linked)x.linked++;}
      return [...map.values()].map(x=>({...x,slips:x.slips.size,items:x.items.size})).sort((a,b)=>b.amount-a.amount||b.lines-a.lines);
    };
    const itemMap=new Map();
    for(const r of rows){if(!itemMap.has(r.item_id))itemMap.set(r.item_id,{id:r.item_id,code:r.code,description:r.item_description,uom:r.uom,lines:0,slips:new Set(),amount:0,centers:new Set(),status:r.stock_status});const x=itemMap.get(r.item_id);x.lines++;x.slips.add(r.slip_no);x.amount+=r.amount_num;x.centers.add(label(r.cost_center));}
    const byItem=[...itemMap.values()].map(x=>({...x,slips:x.slips.size,centers:x.centers.size,center_names:[...x.centers]})).sort((a,b)=>b.slips-a.slips||b.lines-a.lines);
    const byMonth=Array.from({length:12},(_,i)=>({month:i+1,slips:new Set(),lines:0,amount:0}));
    for(const r of rows){if(!r.linked||!r.posting_date)continue;const m=Number(String(r.posting_date).slice(5,7));if(m>=1&&m<=12){const x=byMonth[m-1];x.slips.add(r.slip_no);x.lines++;x.amount+=r.amount_num;}}
    const risk=byItem.filter(x=>x.status==="zero"||x.status==="below_min");
    return {rows,byCenter:group("cost_center"),byActivity:group("activity_code"),byRequestor:group("requestor"),byItem,
      byMonth:byMonth.map(x=>({...x,slips:x.slips.size})),unlinked:rows.filter(x=>!x.linked),risk,
      totalAmount:rows.reduce((n,r)=>n+r.amount_num,0),linked:rows.filter(x=>x.linked).length};
  }
  window.FC=window.FC||{};window.FC.budgetDash={build};
})();

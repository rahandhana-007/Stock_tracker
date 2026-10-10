/* Advisory analysis only. Snapshot = most recent SAP posting date, not today's stock. */
(function(){
  "use strict";
  const dateISO = s => /^\d{4}-\d\d-\d\d$/.test(String(s||"")) ? String(s) : null;
  function addDays(iso,n){const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+Math.round(n));return d.toISOString().slice(0,10);}
  function analyze(items,pr,so,until,partialMonth){
    const anchor=dateISO(until)||so.map(x=>dateISO(x.posting_date)).filter(Boolean).sort().at(-1)||null;
    const year=anchor?Number(anchor.slice(0,4)):null;
    const lastComplete=anchor?(partialMonth||((new Date(anchor+'T00:00:00Z').getUTCDate()<new Date(Date.UTC(year,Number(anchor.slice(5,7)),0)).getUTCDate())?Number(anchor.slice(5,7)):Number(anchor.slice(5,7))+1)):13;
    const soKeys=new Set(so.map(x=>`${x.item_id}|${String(x.doc_no||'').match(/\d+/)?.[0]}`));
    const linked=(pr||[]).filter(p=>p.sap_ref&&soKeys.has(`${p.item_id}|${p.sap_ref}`));
    const userMap=new Map(), requestMap=new Map(), itemUsers=new Map();
    for(const p of linked){
      const cc=String(p.cost_center||'Tidak disebutkan').trim()||'Tidak disebutkan', req=String(p.requestor||'Tidak disebutkan').trim()||'Tidak disebutkan';
      for(const [map,key] of [[userMap,cc],[requestMap,req]]){
        if(!map.has(key))map.set(key,{name:key,lines:0,slips:new Set(),items:new Set()});
        const g=map.get(key);g.lines++;g.slips.add(p.slip_no);g.items.add(Number(p.item_id));
      }
      if(!itemUsers.has(Number(p.item_id)))itemUsers.set(Number(p.item_id),new Map());
      const group=itemUsers.get(Number(p.item_id));group.set(cc,(group.get(cc)||0)+1);
    }
    const finishMap=map=>[...map.values()].map(g=>({name:g.name,lines:g.lines,slips:g.slips.size,items:g.items.size})).sort((a,b)=>b.slips-a.slips||b.lines-a.lines);
    const results=items.map(it=>{
      const c=it.calc||{},stock=c.current_stock,stockKnown=stock!==null&&stock!==undefined&&Number.isFinite(Number(stock));
      const completed=(it.months||[]).map((m,i)=>({month:i+1,value:m.actual})).filter(x=>x.month<lastComplete&&x.value!==null&&x.value!==undefined&&Number.isFinite(Number(x.value)));
      const recent=completed.slice(-3),prior=completed.slice(-6,-3);
      const avg=recent.length?recent.reduce((n,x)=>n+Number(x.value),0)/recent.length:null;
      const priorAvg=prior.length>=2?prior.reduce((n,x)=>n+Number(x.value),0)/prior.length:null;
      const trend=avg!==null&&priorAvg!==null&&priorAvg>0?(avg-priorAvg)/priorAvg:null;
      const variance=recent.length>=2&&avg>0?Math.sqrt(recent.reduce((n,x)=>n+(Number(x.value)-avg)**2,0)/recent.length)/avg:null;
      const daily=avg!==null&&avg>0?avg/30.44:null;
      const min=Math.max(0,Number(it.min_stock)||0),max=Math.max(0,Number(it.max_stock)||0);
      const lead=it.lead_time_days===null||it.lead_time_days===undefined?null:Number(it.lead_time_days);
      const hasLead=lead!==null&&Number.isFinite(lead)&&lead>=0;
      const daysToZero=stockKnown&&daily&&stock>0?Number(stock)/daily:stockKnown&&Number(stock)<=0?0:null;
      const daysToMin=stockKnown&&daily&&Number(stock)>min?(Number(stock)-min)/daily:stockKnown&&Number(stock)<=min?0:null;
      const low=stockKnown&&Number(stock)<=min;
      const trigger=anchor&&daily&&daysToMin!==null?addDays(anchor,daysToMin):null;
      const orderDate=trigger&&hasLead?addDays(trigger,-lead):null;
      const zeroDate=anchor&&daysToZero!==null?addDays(anchor,daysToZero):null;
      const qty=stockKnown?Math.max(0,(max||min)-Number(stock)):null;
      const names=[...(itemUsers.get(Number(it.id))||new Map()).entries()].sort((a,b)=>b[1]-a[1]);
      return {id:it.id,code:it.code,description:it.description,uom:it.uom,stock:stockKnown?Number(stock):null,min,max,lead,avg,priorAvg,trend,variance,monthly:recent.map(x=>x.value),samples:recent.length,completeCount:completed.length,daily,daysToMin,daysToZero,trigger,orderDate,zeroDate,qty,low,
        urgency:stockKnown&&Number(stock)<=0?'empty':low?'below':orderDate&&orderDate<=anchor?'order':daysToMin!==null&&daysToMin<=30?'watch':'normal',users:names,
        evidence:!stockKnown?'Stok belum tersedia':!anchor?'Tanggal SAP belum tersedia':!recent.length?'Actual bulan lengkap belum tersedia':avg===0?'Pemakaian terakhir nol':recent.length<2?'Sampel kurang dari 2 bulan':variance!==null&&variance>.6?'Pemakaian sangat fluktuatif':'Estimasi berbasis rerata historis'};
    });
    const priority={empty:0,below:1,order:2,watch:3,normal:4};results.sort((a,b)=>priority[a.urgency]-priority[b.urgency]||(a.daysToMin??Infinity)-(b.daysToMin??Infinity));
    return {anchor,results,byCenter:finishMap(userMap),byRequestor:finishMap(requestMap),linked:linked.length,totalPR:(pr||[]).length,completeMonthThrough:lastComplete-1};
  }
  window.FC=window.FC||{};window.FC.behavior={analyze};
})();

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { parseCsv } from '../src/csv.js';

test('HTTP 新增、查询、冲突、导出和跨站写入保护',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'machining-api-'));
  const {server,store}=createApp({dataDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body,extra={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/')).status,200);
  const fields={requester:'备料',productCode:'001',productName:'测试物料',quantity:3};
  const response=await post('/api/orders',fields,{'Idempotency-Key':'test1'});assert.equal(response.status,201);const order=await response.json();
  assert.equal((await (await post('/api/orders',fields,{'Idempotency-Key':'test1'})).json()).id,order.id);
  assert.equal((await (await fetch(base+'/api/orders?q=001')).json()).total,1);
  assert.equal((await post('/api/orders',fields,{Origin:'https://evil.example'})).status,403);
  assert.equal((await fetch(base+'/api/orders',{method:'POST',body:JSON.stringify(fields)})).status,415);
  const csv=await (await fetch(base+'/api/export.csv')).text();assert.ok(csv.includes('测试物料'));
  assert.equal((await post('/api/restore',{})).status,400);
  assert.equal((await fetch(base+'/api/unknown')).status,404);
});

test('超过旧 16MB 限制的合法备份仍能导出并恢复',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'machining-large-backup-'));
  const {server,store}=createApp({dataDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const first=store.createOrder({requester:'备料',productCode:'P',productName:'零件',quantity:1,notes:'长'.repeat(2000)},'large-base');
  const seed=store.backup();seed.orders=Array.from({length:3000},(_,i)=>({...seed.orders[0],id:i+1,request_key:'large-'+i}));store.restore(seed);
  const response=await fetch(base+'/api/backup');assert.equal(response.status,200);const text=await response.text();assert.ok(Buffer.byteLength(text)>16*1024*1024);
  const restored=await fetch(base+'/api/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"confirm":"恢复","backup":'+text+'}'});
  assert.equal(restored.status,200);assert.equal((await restored.json()).orders,3000);assert.equal(store.getOrder(first.id).notes.length,2000);
});
test('采购导出保留物料级范围、各子件状态和查询失败提示',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'machining-export-'));
  const {server,store}=createApp({dataDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  store.importData({kind:'bom',text:JSON.stringify([{productCode:'P',materialCode:'M',name:'毛坯',usage:1}])});
  store.cachePurchase({code:'M',queriedAt:'2026-10-23T10:00:00Z',errors:[{stage:'采购订单',error:'无权限'}],documents:[{id:'D',orderNo:'MATERIAL:M',productCode:'M',materialCode:'M',chain:'purchase',type:'采购申请单',occurredAt:'2026-10-23T09:00:00Z',sourceTime:'2026-10-23T10:00:00Z'}]});
  store.createOrder({productCode:'P',productName:'成品',requester:'备料',quantity:1});
  const rows=parseCsv(await(await fetch(`http://127.0.0.1:${server.address().port}/api/export.csv`)).text());
  assert.match(rows[0]['采购范围'],/物料级.*非本单专属/);assert.match(rows[0]['各毛坯采购状态'],/M.*采购申请单/);assert.match(rows[0]['采购查询提示'],/无权限/);
});
test('批量和单笔同步反馈 BOM/采购部分失败，不能报告零失败',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'machining-sync-'));
  const {server,store,s7}=createApp({dataDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  let lookups=0;s7.status=()=>({connected:true});s7.lookup=async code=>{lookups++;return {material:{code,name:'零件'},bom:[],bomStatus:'forbidden',bomError:'BOM 无权限'};};
  const order=store.createOrder({productCode:'P',productName:'成品',requester:'备料',quantity:1});
  const post=async path=>(await fetch(`http://127.0.0.1:${server.address().port}`+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
  const all=await post('/api/sync');assert.equal(all.errors.length,1);assert.match(all.message,/1 项失败/);
  await post(`/api/orders/${order.id}/sync`);assert.equal(lookups,2);
  s7.lookup=async code=>({material:{code,name:'零件'},bom:[{productCode:code,materialCode:'M',name:'毛坯',usage:1}],bomStatus:'available'});
  s7.purchase=async code=>({code,documents:[],queriedAt:new Date().toISOString(),errors:[{stage:'采购订单',error:'无权限'}]});
  const partial=await post('/api/sync');assert.equal(partial.errors.length,1);assert.match(partial.errors[0].error,/无权限/);
  const lookup=await(await fetch(`http://127.0.0.1:${server.address().port}/api/materials/P`)).json();assert.equal(lookup.queryErrors.length,1);
});
test('CSV 不把生产查询失败后保留的历史入库状态当作本次成功结果',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'machining-export-stale-'));
  const {server,store}=createApp({dataDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const order=store.createOrder({productCode:'P',productName:'成品',requester:'备料',quantity:1,productionId:'H',productionRowId:'R',productionNo:'ERP'});
  store.cacheProduction(order.id,{message:'成功',documents:[{id:'D',orderNo:'LOCAL-'+order.id,productCode:'P',chain:'production',type:'产成品入库单',occurredAt:'2026-10-23T09:00:00Z',source:'s7',sourceTime:'2026-10-23T10:00:00Z',productionId:'H',productionRowId:'R'}]});
  store.cacheProduction(order.id,null,'生产查询超时');store.cacheS7('P',{material:{code:'P',name:'成品'},bom:[],bomStatus:'forbidden',bomError:'BOM 无权限'});store.syncOrder(order.id);
  const [row]=parseCsv(await(await fetch(`http://127.0.0.1:${server.address().port}/api/export.csv`)).text());
  assert.equal(row['进度'],'100%');assert.match(row['生产查询提示'],/生产查询超时/);assert.match(row['BOM查询提示'],/BOM 无权限/);assert.match(row['数据来源'],/快照/);
});

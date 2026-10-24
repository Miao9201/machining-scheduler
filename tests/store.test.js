import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const fields = {productCode:'P1',productName:'零件',quantity:10,orderNo:'ORD1',batch:'B1',requester:'下单人甲'};
function fixture(t) { const dir = mkdtempSync(join(tmpdir(),'machining-')); const store = new Store(join(dir,'app.sqlite')); t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});}); return {store,dir}; }

test('重复提交幂等、持久化和乐观锁',t=>{
  const {store,dir}=fixture(t);
  const a=store.createOrder(fields,'key1'), b=store.createOrder(fields,'key1');
  assert.equal(a.id,b.id); assert.equal(store.listOrders().total,1);
  assert.throws(()=>store.updateOrder(a.id,{...fields,quantity:12,version:0}),/修改/);
  const updated=store.updateOrder(a.id,{...fields,quantity:12,version:a.version});
  assert.equal(updated.quantity,12);
  const reopened=new Store(join(dir,'app.sqlite')); assert.equal(reopened.getOrder(a.id).quantity,12); reopened.close();
});
test('导入整批校验回滚、多子件保留、缺物料与无 BOM 可区分',t=>{
  const {store}=fixture(t);
  const a=store.createOrder(fields,'a'); assert.equal(a.snapshot.materialStatus,'missing');
  assert.throws(()=>store.importData({kind:'materials',format:'json',text:JSON.stringify([{code:'P1',name:'零件',spec:'A'},{code:'P2',name:''}])}),/名称/);
  assert.equal(store.material('P1').material,null);
  store.importData({kind:'materials',format:'json',text:JSON.stringify([{code:'P1',name:'零件',spec:'A'}])});
  assert.equal(store.getOrder(a.id).snapshot.bomStatus,'missing');
  const body={kind:'bom',format:'json',text:JSON.stringify([{productCode:'P1',materialCode:'M1',name:'毛坯1',usage:1},{productCode:'P1',materialCode:'M2',name:'毛坯2',usage:2}])};
  store.importData(body); store.importData(body);
  assert.equal(store.getOrder(a.id).snapshot.bom.length,2);
});
test('状态源记录可追溯，撤销更正幂等，同产品不串订单',t=>{
  const {store}=fixture(t); const a=store.createOrder(fields,'a'),b=store.createOrder({...fields,orderNo:'ORD2'},'b');
  const d={id:'DOC1',orderNo:'ORD1',productCode:'P1',batch:'B1',chain:'production',type:'检验单',occurredAt:'2026-10-20T08:00:00+08:00',quantity:8,scrap:1};
  const imp=rows=>store.importData({kind:'documents',format:'json',text:JSON.stringify(rows)});
  imp([d]); imp([d]);
  assert.equal(store.getOrder(a.id).snapshot.actualQuantity,8); assert.equal(store.getOrder(a.id).snapshot.progress,80);
  assert.equal(store.getOrder(b.id).snapshot.actualQuantity,null);
  assert.equal(store.getOrder(a.id).snapshot.documents[0].source,'import');
  imp([{...d,cancelled:true}]); assert.equal(store.getOrder(a.id).snapshot.progress,0);
});
test('备份恢复保持一致，无效备份不改当前数据，恢复前生成备份',t=>{
  const {store}=fixture(t); const a=store.createOrder(fields,'a'); const backup=store.backup();
  store.updateOrder(a.id,{...fields,quantity:20,version:a.version});
  const invalid=structuredClone(backup); invalid.orders[0].payload.quantity=-1;
  assert.throws(()=>store.restore(invalid),/数量/); assert.equal(store.getOrder(a.id).quantity,20);
  const result=store.restore(backup); assert.equal(store.getOrder(a.id).quantity,10); assert.ok(result.safetyBackup);
});
test('完整备份保留超过 200 条审计，并支持演示库自身备份恢复',t=>{
  const {store}=fixture(t);store.createOrder(fields,'a');store.meta('demoSeeded',true);
  for(let i=0;i<205;i++)store.log('测试审计',{i});
  const backup=store.backup();assert.equal(backup.audit.length,206);
  store.restore(backup);assert.equal(store.meta('demoSeeded'),true);
});
test('订单文件增量导入和行顺序变化不会重复新增',t=>{
  const {store}=fixture(t),a=fields,b={...fields,orderNo:'ORD2'};
  const imp=rows=>store.importData({kind:'orders',format:'json',text:JSON.stringify(rows)});
  imp([a]);imp([a,b]);imp([b,a]);assert.equal(store.listOrders().total,2);
});
test('采购只关联当前 BOM 子件，并保留各子件独立进度',t=>{
  const {store}=fixture(t);const a=store.createOrder(fields,'a');
  store.importData({kind:'bom',format:'json',text:JSON.stringify([{productCode:'P1',materialCode:'M1',name:'毛坯',usage:1}])});
  store.importData({kind:'documents',format:'json',text:JSON.stringify([{id:'BAD',...fields,chain:'purchase',type:'采购入库单',materialCode:'M-NOT-IN-BOM',occurredAt:'2026-10-23T00:00:00Z'}])});
  assert.equal(store.getOrder(a.id).snapshot.purchaseStatus,null);
});
test('S7 主键关联在无销售订单号时仍可同步并备份恢复，查询期间更换绑定拒绝覆盖',t=>{
  const {store}=fixture(t);const o=store.createOrder({...fields,orderNo:'',productionId:'H1',productionRowId:'R1',productionNo:'ERP1'},'a');
  const result={message:'ERP 主键关联',documents:[{id:'D1',orderNo:`LOCAL-${o.id}`,productCode:'P1',batch:'B1',chain:'production',type:'检验单',documentNo:'QC1',occurredAt:'2026-10-23T10:00:00+08:00',quantity:9,scrap:1,source:'s7',sourceTime:'2026-10-23T10:00:00Z',productionId:'H1',productionRowId:'R1'}]};
  store.cacheProduction(o.id,result,null,o);assert.equal(store.syncOrder(o.id).snapshot.actualQuantity,9);
  const backup=store.backup();store.restore(backup);assert.equal(store.getOrder(o.id).snapshot.progress,80);
  const current=store.getOrder(o.id);store.updateOrder(o.id,{...current,productionId:'H2',productionRowId:'R2',productionNo:'ERP2'});
  assert.throws(()=>store.cacheProduction(o.id,result,null,o),/查询期间/);
});
test('物料级采购对多个订单明确共享，备份恢复保留来源，失败保留原成功快照',t=>{
  const {store}=fixture(t);const a=store.createOrder(fields,'a'),b=store.createOrder({...fields,orderNo:'ORD2'},'b');
  store.importData({kind:'bom',format:'json',text:JSON.stringify([{productCode:'P1',materialCode:'M1',name:'毛坯',usage:1}])});
  const result={code:'M1',queriedAt:'2026-10-23T10:00:00Z',errors:[],documents:[{id:'M-PO1',orderNo:'MATERIAL:M1',productCode:'M1',batch:'',materialCode:'M1',chain:'purchase',type:'采购入库单',documentNo:'PO1',occurredAt:'2026-10-23T08:00:00+08:00',sourceTime:'2026-10-23T10:00:00Z'}]};
  store.cachePurchase(result);store.syncAll();
  assert.equal(store.getOrder(a.id).snapshot.purchaseStatus,'采购入库单');assert.equal(store.getOrder(b.id).snapshot.purchaseScope,'material');
  const backup=store.backup();store.restore(backup);assert.equal(store.getOrder(a.id).snapshot.documents[0].scope,'material');
  store.cachePurchase({...result,documents:[],errors:[{stage:'采购订单',error:'无权限'}]});store.syncAll();
  assert.equal(store.getOrder(a.id).snapshot.purchaseStatus,'采购入库单');assert.equal(store.getOrder(a.id).snapshot.purchaseErrors.length,1);
});
test('离线修改本工具订单号不改变已绑定 S7 生产行的进度',t=>{
  const {store}=fixture(t);const a=store.createOrder({...fields,productionId:'H1',productionRowId:'R1',productionNo:'ERP1'},'a');
  store.cacheProduction(a.id,{message:'已关联',documents:[{id:'D1',orderNo:fields.orderNo,productCode:'P1',batch:'B1',chain:'production',type:'检验单',occurredAt:'2026-10-23T10:00:00+08:00',quantity:9,scrap:1,source:'s7',sourceTime:'2026-10-23T10:00:00Z',productionId:'H1',productionRowId:'R1'}]});
  const o=store.getOrder(a.id);store.updateOrder(a.id,{...o,orderNo:'NEW-NO'});assert.equal(store.getOrder(a.id).snapshot.progress,80);
});
test('恢复保留 S7 物料已失效和 BOM 查询失败的原状态',t=>{
  const {store}=fixture(t);store.createOrder(fields,'a');
  store.cacheS7('P1',{material:{code:'P1',name:'零件',spec:'A'},bom:[{productCode:'P1',materialCode:'M1',name:'毛坯',usage:1}],bomStatus:'available'});
  store.cacheS7('P1',{material:{code:'P1',name:'零件',spec:'A'},bom:[],bomStatus:'forbidden',bomError:'无查询权限'});
  store.restore(store.backup());assert.equal(store.material('P1').bomStatus,'forbidden');assert.equal(store.material('P1').bomError,'无查询权限');
  store.cacheS7('P1',{material:null,bom:[],bomStatus:'not-queried'});store.restore(store.backup());assert.equal(store.material('P1').materialStatus,'missing');
});
test('物料消失时旧 BOM 只作为历史缓存保留，并明确未重新查询',t=>{
  const {store}=fixture(t);
  store.cacheS7('P1',{material:{code:'P1',name:'零件'},bom:[{productCode:'P1',materialCode:'M1',name:'毛坯',usage:1}],bomStatus:'available'});
  store.cacheS7('P1',{material:null,bom:[],bomStatus:'not-queried'});
  const lookup=store.material('P1');assert.equal(lookup.bomStatus,'not-queried');assert.match(lookup.bomError,/存货/);assert.equal(lookup.bom.length,1);
});
test('首次 ERP 查询失败的错误在备份恢复后仍可见',t=>{
  const {store}=fixture(t);const order=store.createOrder({...fields,productionId:'H1',productionRowId:'R1',productionNo:'ERP1'},'failed');
  store.cacheProduction(order.id,null,'S7 请求超时');store.restore(store.backup());
  assert.equal(store.getOrder(order.id).snapshot.erpError,'S7 请求超时');
});
test('只导入 BOM 或物料后，S7 存货缺失状态仍可备份恢复',t=>{
  const {store}=fixture(t);
  store.importData({kind:'bom',text:JSON.stringify([{productCode:'P1',materialCode:'M1',name:'毛坯',usage:1}])});
  store.cacheS7('P1',{material:null,bom:[],bomStatus:'not-queried'});
  assert.equal(store.material('P1').bomStatus,'not-queried');
  store.importData({kind:'materials',text:JSON.stringify([{code:'P1',name:'导入零件'}])});
  store.cacheS7('P1',{material:null,bom:[],bomStatus:'not-queried'});store.restore(store.backup());
  assert.equal(store.material('P1').materialStatus,'missing');assert.equal(store.material('P1').bomStatus,'not-queried');
});

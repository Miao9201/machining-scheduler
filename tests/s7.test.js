import test from 'node:test';
import assert from 'node:assert/strict';
import { mapMaterial, mapBom, s7Time,protectSecret,S7,mapProduction,mapPurchase } from '../src/s7.js';
test('S7 存货查询按编码精确匹配，重复和字段缺失不冒充成功',()=>{
  assert.equal(mapMaterial('DEMO-P001',[{id:'ID1',invCode:'DEMO-P001',invName:'演示零件',spec:'演示规格'}]).spec,'演示规格');
  assert.equal(mapMaterial('P',[{invCode:'PX',invName:'其他'}]),null);
  assert.throws(()=>mapMaterial('P',[{invCode:'P',invName:'A'},{invCode:'P',invName:'B'}]),/重复/);
  assert.throws(()=>mapMaterial('P',[{invCode:'P'}]),/名称/);
});
test('S7 BOM 只接受唯一生效主 BOM，按母件产出数量折算全部子件',()=>{
  const h={id:'BOM1',inventoryCode:'P',bomType:0,billState:2,isClose:false,isHistory:false,productQuantum:10};
  const b={bomId:'BOM1',inventoryCode:'M1',inventoryName:'毛坯',inventorySpec:'304',quantum:20};
  const result=mapBom('P',{rows:[h],DetailTableList:[b,{...b,inventoryCode:'M2',quantum:5}]});
  assert.equal(result.status,'available');assert.deepEqual(result.rows.map(x=>x.usage),[2,.5]);
  assert.equal(mapBom('X',{rows:[h],DetailTableList:[b]}).status,'missing');
  assert.throws(()=>mapBom('P',{rows:[h,{...h,id:'BOM2'}],DetailTableList:[b]}),/多个/);
  assert.throws(()=>mapBom('P',{rows:[h],DetailTableList:[{...b,bomId:'OTHER'}]}),/明细/);
});
test('S7 时间转换保留中国时区，缺少时间不填当前时间',()=>{
  assert.equal(s7Time('2026-10-23 14:03:11 356'),'2026-10-23T14:03:11+08:00');
  assert.equal(s7Time(null),null);
});
test('Windows DPAPI 加密配置可完整解密，兼容宿主 PSModulePath', {skip:process.platform!=='win32'},async()=>{
  const sample=JSON.stringify({username:'测试用虚构账号',password:'test-only-not-a-real-secret'});
  const encrypted=await protectSecret(sample);assert.ok(encrypted.length>100);assert.ok(!encrypted.includes('test-only'));
  assert.equal(await protectSecret(encrypted,true),sample);
});
test('S7 新 iframe URL 尚为空时仍可找到已打开的档案页面',async()=>{
  const connector=new S7('.');const target={url:()=> 'http://127.0.0.1:18088/bd/DOC000030/View.htm?token=test'};
  connector.page={frames:()=>[{url:()=>''},target]};
  assert.equal(await connector.frame('存货档案','/bd/DOC000030/View.htm'),target);
});
test('S7 生产关联使用头和行主键，工序/采购检验及重复项目不计入最终数量',()=>{
  const o={id:1,orderNo:'LOCAL1',productCode:'P1',batch:'',productionId:'H1',productionRowId:'R1'};
  const root={h_id:'H1',id:'R1',inventorycode:'P1',h_billno:'ERP1',h_billstate:2,h_createTs:'2026-10-01 08:00:00'};
  const inspection={h_id:'Q1',id:'QB1',h_billno:'QC1',h_billstate:2,h_createTs:'2026-10-03 08:00:00',inventorycode:'P1',purchaseorderid:'H1',purchaseorderrowid:'R1',frombilltypename:'生产报检单',quantum:10,wastequantum:1};
  const receipt={h_id:'I1',id:'IB1',h_billno:'IN1',h_billstate:2,h_createTs:'2026-10-04 08:00:00',inventorycode:'P1',productionorderid:'H1',productionorderrowid:'R1',batchcode:'NEW-BATCH'};
  const docs=mapProduction(o,root,{inspections:[inspection,inspection,{...inspection,id:'QB2',frombilltypename:'工序报检单',quantum:999},{...inspection,id:'QB3',frombilltypename:'采购报检单',quantum:888},{...inspection,id:'QB4',purchaseorderrowid:'OTHER',quantum:777}],receipts:[receipt]});
  assert.deepEqual(docs.map(d=>d.type),['生产加工单','检验单','产成品入库单']);
  assert.equal(docs.find(d=>d.type==='检验单').quantity,10);assert.equal(docs.find(d=>d.type==='产成品入库单').sourceBatch,'NEW-BATCH');
  assert.throws(()=>mapProduction({...o,productCode:'OTHER'},root,{}),/不匹配/);
});
test('采购状态明确为物料级，排除其他编码、未审核单据和生产检验',()=>{
  const row={id:'Q1',h_billno:'QC1',h_billstate:2,h_createTs:'2026-10-23 10:00:00',inventorycode:'M1',frombilltypename:'采购报检单'};
  const docs=mapPurchase('M1',{inspections:[row,row,{...row,id:'OTHER',inventorycode:'M2'},{...row,id:'PROD',frombilltypename:'生产报检单'}],stages:[{id:'PO1',documentNo:'P01',type:'采购订单',billState:2,materialCode:'M1',occurredAt:'2026-10-22T10:00:00+08:00'}]});
  assert.equal(docs.length,2);assert.ok(docs.every(d=>d.scope==='material'));assert.ok(docs.every(d=>d.chain==='purchase'));
});
test('生产源行缺少 ID 时拒绝汇总，防止多张检验单合并成同一行',()=>{
  const order={id:1,productCode:'P1',productionId:'H1',productionRowId:'R1'};
  const root={h_id:'H1',id:'R1',inventorycode:'P1',h_billstate:2,h_billno:'ERP1',h_createTs:'2026-10-01 08:00:00'};
  const row={inventorycode:'P1',purchaseorderid:'H1',purchaseorderrowid:'R1',frombilltypename:'生产报检单',h_billstate:2,h_createTs:'2026-10-02 08:00:00',quantum:3,wastequantum:0};
  assert.throws(()=>mapProduction(order,root,{inspections:[row]}),/主键/);
});

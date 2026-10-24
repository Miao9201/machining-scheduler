import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, validateOrder, normalizeDocument } from '../src/domain.js';
import { parseCsv, writeCsv } from '../src/csv.js';

const order = { orderNo: 'O-1', productCode: 'P-1', batch: 'B-1' };
const doc = (id, type, extra = {}) => ({ id, ...order, chain: 'production', type, occurredAt: '2026-10-20T08:00:00+08:00', cancelled: false, ...extra });

test('订单/产品/批次隔离，不匹配或未知数量保留 null', () => {
  const result = summarize(order, [doc('1', '检验单', {orderNo:'O-2', quantity: 20, scrap: 1}), doc('2','报检单',{batch:'B-2'})]);
  assert.equal(result.progress, 0); assert.equal(result.actualQuantity, null); assert.equal(result.latestStatus, null);
});
test('按时间选择最新有效单据，五阶段各 20%，采购检验不污染生产', () => {
  const result = summarize(order, [doc('1','产成品入库单',{occurredAt:'2026-10-21T08:00:00+08:00', cancelled:true}), doc('2','检验单',{quantity:8,scrap:2}), doc('3','报检单',{occurredAt:'2026-10-19T08:00:00+08:00'}), doc('4','检验单',{chain:'purchase',materialCode:'M1',quantity:999,scrap:999})]);
  assert.equal(result.progress,80); assert.equal(result.actualQuantity,8); assert.equal(result.scrapQuantity,2); assert.equal(result.completedAt,'2026-10-19T08:00:00+08:00'); assert.equal(result.purchaseStatus,'检验单');
});
test('每个阶段映射准确，后来的退回阶段不保留虚假最高进度', () => {
  for (const [i,type] of ['生产加工单','材料出库单','报检单','检验单','产成品入库单'].entries()) assert.equal(summarize(order,[doc('x',type)]).progress,(i+1)*20);
  assert.equal(summarize(order,[doc('1','检验单'),doc('2','材料出库单',{occurredAt:'2026-10-22T00:00:00Z'})]).progress,40);
});
test('数量、日期和必填校验，合同号或下单人二选一', () => {
  assert.throws(()=>validateOrder({productCode:'P',productName:'物料',quantity:0,requester:'下单人甲'}),/数量/);
  assert.throws(()=>validateOrder({productCode:'P',productName:'物料',quantity:2,requester:'下单人甲',dueDate:'2026-02-30'}),/日期/);
  assert.throws(()=>validateOrder({productCode:'P',productName:'物料',quantity:2}),/下单人/);
  assert.equal(validateOrder({productCode:' P ',productName:' 物料 ',quantity:'2.5',orderNo:'O',dueMode:'asap'}).quantity,2.5);
});
test('源单据拒绝错误链、无关联、负数及非布尔撤销值',()=>{
  assert.throws(()=>normalizeDocument(doc('1','检验单',{chain:'other'})),/链/);
  assert.throws(()=>normalizeDocument(doc('1','检验单',{orderNo:''})),/订单/);
  assert.throws(()=>normalizeDocument(doc('1','检验单',{quantity:-1})),/数量/);
  assert.throws(()=>normalizeDocument(doc('1','检验单',{cancelled:'false'})),/撤销/);
});
test('CSV 保留中文、引号、换行并防导出公式注入',()=>{
  assert.deepEqual(parseCsv('\uFEFF编码,名称\r\n001,"中文,""测试""\n第二行"\r\n'),[{编码:'001',名称:'中文,"测试"\n第二行'}]);
  assert.throws(()=>parseCsv('a,b\n"bad'),/引号/);
  assert.throws(()=>parseCsv('a,a\n1,2'),/重复/);
  assert.match(writeCsv([{a:'=1+1',b:'正常'}],['a','b']),/'=1\+1/);
});
test('同日单据仅有日期精度时按工序链确定先后，不将午夜当实际发生时间',()=>{
  const result=summarize(order,[doc('p','生产加工单',{occurredAt:'2026-10-20T18:25:14+08:00'}),doc('m','材料出库单',{occurredAt:'2026-10-20T00:00:00+08:00',timePrecision:'date'})]);
  assert.equal(result.progress,40);
});
test('空白检验数量保持未知，不将空格转换成真实零产量',()=>{
  const d=normalizeDocument(doc('blank','检验单',{quantity:'  ',scrap:'\t'}));
  assert.equal(d.quantity,null);assert.equal(d.scrap,null);
});

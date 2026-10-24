export const PRODUCTION = ['生产加工单', '材料出库单', '报检单', '检验单', '产成品入库单'];
export const PURCHASE = ['采购申请单', '采购订单', '采购报检单', '检验单', '采购入库单'];
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function text(value, max = 500) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new AppError('字段必须是文字或数字');
  const result = String(value).trim();
  if (result.length > max) throw new AppError(`字段长度不能超过 ${max}`);
  return result;
}
export function number(value, label, { nullable = false, positive = false } = {}) {
  if(typeof value==='string')value=value.trim();
  if (value == null || value === '') { if (nullable) return null; throw new AppError(`${label}不能为空`); }
  if (typeof value !== 'number' && typeof value !== 'string') throw new AppError(`${label}必须为数字`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e12 || (positive && n === 0)) throw new AppError(`${label}必须为${positive ? '大于零的' : '非负'}有效数字`);
  return n;
}
export function date(value, label = '日期') {
  if (!value) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new AppError(`${label}不是有效日期`);
  return value;
}
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new AppError('单据时间须为含时区的 ISO 时间');
  date(value.slice(0, 10), '单据日期');
  return value;
}
export function validateOrder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('订单格式错误');
  const o = {};
  for (const key of ['requester','orderNo','productCode','productName','batch','drawingStatus','blankAvailable','completionNote','cuttingSize','notes','productionId','productionRowId','productionNo']) o[key] = text(input[key], key === 'notes' ? 2000 : 200);
  if([o.productionId,o.productionRowId,o.productionNo].some(Boolean)&&![o.productionId,o.productionRowId,o.productionNo].every(Boolean))throw new AppError('S7 生产单关联信息不完整，请重新选择');
  if (!o.productCode) throw new AppError('成品编码不能为空');
  if (!o.productName) throw new AppError('物料名称不能为空，可先输入编码查询');
  if (!o.requester && !o.orderNo) throw new AppError('下单人或订单号至少填写一项');
  o.quantity = number(input.quantity, '需求数量', { positive: true });
  o.dueMode = input.dueMode || 'date';
  if (!['date','asap','other'].includes(o.dueMode)) throw new AppError('需求时间方式错误');
  o.dueDate = date(input.dueDate, '需求日期');
  if (o.dueMode !== 'date') o.dueDate = null;
  o.deliveryDate = date(input.deliveryDate, '订单交期');
  return o;
}
export function normalizeMaterial(input) {
  const code = text(input.code,200), name = text(input.name,200), spec = text(input.spec,500);
  if (!code || !name) throw new AppError('物料编码和名称不能为空');
  return { code, name, spec };
}
export function normalizeBom(input) {
  const b = {};
  for (const key of ['productCode','materialCode','name','spec']) b[key] = text(input[key],500);
  if(input.sourceRowKey)b.sourceRowKey=text(input.sourceRowKey,200);
  if (!b.productCode || !b.materialCode || !b.name) throw new AppError('BOM 成品编码、子件编码和名称不能为空');
  b.usage = number(input.usage,'单个用量',{positive:true});
  return b;
}
export function normalizeDocument(input) {
  const d = {};
  for (const key of ['id','orderNo','productCode','batch','materialCode','type','chain','documentNo']) d[key] = text(input[key],200);
  if (!d.id || !d.orderNo || !d.productCode) throw new AppError('源单据 ID、订单号、成品编码不能为空');
  if (!['production','purchase'].includes(d.chain)) throw new AppError('单据业务链错误');
  if (!(d.chain === 'production' ? PRODUCTION : PURCHASE).includes(d.type)) throw new AppError('单据类型不属于所选业务链');
  if (d.chain === 'purchase' && !d.materialCode) throw new AppError('采购单据必须包含物料编码');
  if (input.cancelled != null && typeof input.cancelled !== 'boolean') throw new AppError('撤销字段必须为布尔值');
  d.cancelled = input.cancelled ?? false;
  d.occurredAt = timestamp(input.occurredAt);
  if(input.timePrecision!=null){if(!['date','second'].includes(input.timePrecision))throw new AppError('单据时间精度错误');d.timePrecision=input.timePrecision;}
  if(input.sourceBatch!=null)d.sourceBatch=text(input.sourceBatch,200);
  d.quantity = number(input.quantity,'检验数量',{nullable:true});
  d.scrap = number(input.scrap,'报废数量',{nullable:true});
  if (d.quantity != null && d.scrap != null && d.scrap > d.quantity) throw new AppError('报废数量不能超过检验数量');
  return d;
}
export function normalizePurchase(input){
  const code=text(input.code,200);if(!code||!Array.isArray(input.documents)||input.documents.length>10000)throw new AppError('物料采购快照格式错误');
  const queriedAt=timestamp(input.queriedAt);
  const documents=input.documents.map(d=>{const row=normalizeDocument(d);if(row.chain!=='purchase'||row.materialCode!==code)throw new AppError('物料采购快照含其他物料或业务链');return {...row,scope:'material',source:'s7',sourceTime:timestamp(d.sourceTime)};});
  const errors=(input.errors||[]).map(x=>({stage:text(x.stage,200),error:text(x.error,500)}));
  return {code,documents,queriedAt,scope:'material',errors};
}
export function summarize(order, documents, materialCodes) {
  const matching = documents.filter(d => !d.cancelled && d.orderNo === order.orderNo && d.productCode === order.productCode && (d.batch || '') === (order.batch || ''));
  const day=d=>new Date(Date.parse(d.occurredAt)+8*3600000).toISOString().slice(0,10);
  const sorted = chain => {
    const rows=matching.filter(d=>d.chain===chain),imprecise=new Set(rows.filter(d=>d.timePrecision==='date').map(day)),stages=chain==='production'?PRODUCTION:PURCHASE;
    return rows.sort((a,b)=>day(b).localeCompare(day(a))||(imprecise.has(day(a))?stages.indexOf(b.type)-stages.indexOf(a.type):0)||Date.parse(b.occurredAt)-Date.parse(a.occurredAt)||stages.indexOf(b.type)-stages.indexOf(a.type)||a.id.localeCompare(b.id));
  };
  const production = sorted('production'), purchase = sorted('purchase').filter(d=>!materialCodes||materialCodes.has(d.materialCode));
  const latest = production[0];
  const inspections = production.filter(d => d.type === '检验单');
  const sum = field => inspections.length && inspections.every(d => d[field] != null) ? inspections.reduce((total,d) => total + d[field],0) : null;
  const notified = production.find(d => d.type === '报检单');
  return { latestStatus: latest?.type ?? null, progress: latest ? (PRODUCTION.indexOf(latest.type) + 1) * 20 : 0,
    completedAt: notified?.occurredAt ?? null, actualQuantity: sum('quantity'), scrapQuantity: sum('scrap'),
    purchaseStatus: purchase[0]?.type ?? null, purchaseByMaterial:Object.fromEntries([...new Set(purchase.map(d=>d.materialCode))].map(code=>[code,purchase.find(d=>d.materialCode===code).type])), documents: [...production,...purchase] };
}

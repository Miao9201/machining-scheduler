import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AppError, validateOrder, normalizeMaterial, normalizeBom, normalizeDocument,normalizePurchase, summarize, text } from './domain.js';
import { parseCsv } from './csv.js';

const normalizers = {materials:normalizeMaterial,bom:normalizeBom,documents:normalizeDocument,orders:validateOrder};
const keyOf = (kind, row) => kind === 'materials' ? row.code : kind === 'bom' ? JSON.stringify([row.productCode,row.materialCode,...(row.sourceRowKey?[row.sourceRowKey]:[])]) : JSON.stringify([row.chain,row.id]);
const orderImportKey=row=>'import-row:'+createHash('sha256').update(JSON.stringify(row)).digest('hex');
const now = () => new Date().toISOString();
export class Store {
  constructor(path) {
    this.path=path;
    mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL,request_key TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS items (kind TEXT NOT NULL,item_key TEXT NOT NULL,payload TEXT NOT NULL,source TEXT NOT NULL,source_time TEXT NOT NULL,PRIMARY KEY(kind,item_key));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r=fn(); this.db.exec('COMMIT');return r; } catch(e) {this.db.exec('ROLLBACK');throw e;} }
  log(action,detail) {this.db.prepare('INSERT INTO audit(at,action,detail) VALUES(?,?,?)').run(now(),action,JSON.stringify(detail));}
  audit() {return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all().map(r=>({...r,detail:JSON.parse(r.detail)}));}
  meta(key,value) { if(value === undefined) {const r=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return r?JSON.parse(r.value):null;} this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,JSON.stringify(value)); }
  items(kind) {return this.db.prepare('SELECT payload,source,source_time FROM items WHERE kind=?').all(kind).map(r=>({...JSON.parse(r.payload),source:r.source,sourceTime:r.source_time}));}
  material(code) {const saved=this.items('materials').find(x=>x.code===code)??null;const material=saved?.s7Missing?null:saved;const bom=this.items('bom').filter(x=>x.productCode===code);return {material,bom,materialStatus:material?'available':'missing',bomStatus:saved?.s7BomStatus||(bom.length?'available':'missing'),bomError:saved?.s7BomError||null,connection:material?.source==='s7'?'s7-cache':'import-only'};}
  cacheS7(code,result){
    return this.transaction(()=>{
      const time=result.queriedAt||now();
      const old=this.items('materials').find(x=>x.code===code);
      if(result.material)this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?,?,?,?)').run('materials',code,JSON.stringify({...result.material,s7BomStatus:result.bomStatus,s7BomError:result.bomError}),'s7',time);
      else {
        // 缺失标记也要持久化；material() 会隐藏此记录，不将占位名称当作存货查询结果。
        const missing={...(old||{code,name:code,spec:''}),s7Missing:true,s7BomStatus:'not-queried',s7BomError:'S7 未找到该存货，BOM 未重新查询；明细如有为历史缓存'};
        this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?,?,?,?)').run('materials',code,JSON.stringify(missing),'s7',time);
      }
      if(['available','missing'].includes(result.bomStatus)){
        for(const row of this.db.prepare('SELECT item_key,payload FROM items WHERE kind=?').all('bom'))if(JSON.parse(row.payload).productCode===code)this.db.prepare('DELETE FROM items WHERE kind=? AND item_key=?').run('bom',row.item_key);
        for(const row of result.bom)this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?,?,?,?)').run('bom',keyOf('bom',row),JSON.stringify(row),'s7',time);
      }
      this.log('S7 只读查询',{productCode:code,materialFound:!!result.material,bomStatus:result.bomStatus,bomCount:result.bom.length});
      return this.material(code);
    });
  }
  cachePurchase(result){
    const row=normalizePurchase(result);const old=this.items('purchase').find(x=>x.code===row.code);
    if(row.errors.length&&old){row.documents=old.documents;row.previousSuccessAt=old.queriedAt;}
    this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?,?,?,?)').run('purchase',row.code,JSON.stringify(row),'s7',row.queriedAt);
    this.log('S7 物料级采购查询',{materialCode:row.code,count:row.documents.length,failures:row.errors.length});return row;
  }
  snapshot(order) {
    const lookup=this.material(order.productCode),effective={...order,orderNo:order.orderNo||(order.productionId?`LOCAL-${order.id}`:'')};
    const live=(order.erpDocuments||[]).filter(d=>d.productionId===order.productionId&&d.productionRowId===order.productionRowId&&d.productCode===order.productCode).map(d=>({...d,orderNo:effective.orderNo,batch:order.batch||''}));
    let documents=order.productionId?[...this.items('documents').filter(d=>d.chain==='purchase'),...live]:this.items('documents');
    const purchase=this.items('purchase').filter(p=>lookup.bom.some(b=>b.materialCode===p.code));
    const syncedCodes=new Set(purchase.map(p=>p.code));
    documents=documents.filter(d=>d.chain!=='purchase'||!syncedCodes.has(d.materialCode));
    documents.push(...purchase.flatMap(p=>p.documents.map(d=>({...d,orderNo:effective.orderNo,productCode:order.productCode,batch:order.batch||'',scope:'material'}))));
    const summary=summarize(effective,documents,new Set(lookup.bom.map(b=>b.materialCode)));
    return {...lookup,...summary,purchaseScope:purchase.length?'material':'order-import',purchaseErrors:purchase.flatMap(p=>p.errors.map(x=>({materialCode:p.code,...x}))),syncedAt:now(),source: [...(lookup.material?[lookup.material]:[]),...lookup.bom,...summary.documents].some(x=>x.source==='s7')?'s7':'import',
      associationStatus:order.productionId?'erp-linked':order.orderNo?'exact':'missing-order',message:order.productionId?(order.erpMessage||'已选择 S7 生产加工单，等待查询'):(order.orderNo?'按订单号、成品编码、批次精确关联':'未填写订单号，无法自动关联生产/采购单据'),erpError:order.erpError||null};
  }
  decode(row) { if(!row)throw new AppError('记录不存在',404);return {...JSON.parse(row.payload),id:row.id,createdAt:row.created_at,updatedAt:row.updated_at,version:row.version}; }
  getOrder(id) {return this.decode(this.db.prepare('SELECT * FROM orders WHERE id=?').get(Number(id)));}
  createOrder(input,requestKey=randomUUID()) {
    requestKey=text(requestKey,200); if(!requestKey)throw new AppError('缺少提交标识');
    const exists=this.db.prepare('SELECT * FROM orders WHERE request_key=?').get(requestKey);if(exists)return this.decode(exists);
    const order=validateOrder(input);order.snapshot=this.snapshot(order);const time=now();
    const id=Number(this.db.prepare('INSERT INTO orders(payload,created_at,updated_at,version,request_key) VALUES(?,?,?,?,?)').run(JSON.stringify(order),time,time,1,requestKey).lastInsertRowid);
    this.log('新增订单',{id,productCode:order.productCode,orderNo:order.orderNo});return this.getOrder(id);
  }
  updateOrder(id,input) {
    const existing=this.getOrder(id);
    if(input.version!==existing.version)throw new AppError('记录已被修改，请刷新后再编辑',409);
    const order=validateOrder(input);order.snapshot=this.snapshot(order);
    if(order.productionId===existing.productionId&&order.productionRowId===existing.productionRowId&&order.productCode===existing.productCode&&order.batch===existing.batch){order.erpDocuments=existing.erpDocuments;order.erpMessage=existing.erpMessage;order.erpError=existing.erpError;order.snapshot=this.snapshot({...order,id:Number(id)});}
    this.db.prepare('UPDATE orders SET payload=?,updated_at=?,version=version+1 WHERE id=?').run(JSON.stringify(order),now(),Number(id));
    this.log('修改订单',{id:Number(id)});return this.getOrder(id);
  }
  deleteOrder(id,version) {
    const order=this.getOrder(id);if(version!==order.version)throw new AppError('记录已被修改，请刷新后再删除',409);
    this.db.prepare('DELETE FROM orders WHERE id=?').run(Number(id));this.log('删除订单',{id:Number(id),orderNo:order.orderNo,productCode:order.productCode});
  }
  syncOrder(id) {
    const order=this.getOrder(id);const {id:_,createdAt,updatedAt,version,...payload}=order;
    payload.snapshot=this.snapshot({...payload,id:Number(id)});
    this.db.prepare('UPDATE orders SET payload=?,updated_at=?,version=version+1 WHERE id=?').run(JSON.stringify(payload),now(),Number(id));
    return this.getOrder(id);
  }
  cacheProduction(id,result,error=null,expected=null){
    const o=this.getOrder(id),{createdAt,updatedAt,version,...payload}=o;
    if(expected&&['productionId','productionRowId','productCode','batch','orderNo'].some(k=>(o[k]||'')!==(expected[k]||'')))throw new AppError('查询期间订单已修改，请重新查询',409);
    if(result){payload.erpDocuments=result.documents;payload.erpMessage=result.message;payload.erpError=null;}else payload.erpError=error;
    payload.snapshot=this.snapshot(payload);delete payload.id;
    this.db.prepare('UPDATE orders SET payload=?,updated_at=?,version=version+1 WHERE id=?').run(JSON.stringify(payload),now(),id);
    this.log(result?'S7 生产单据查询':'S7 生产查询失败',{id,count:result?.documents.length||0,error:error||null});return this.getOrder(id);
  }
  syncAll() {const rows=this.db.prepare('SELECT id FROM orders').all();for(const r of rows)this.syncOrder(r.id);return {count:rows.length,source:'import',message:'已按本地导入资料重新关联，非实时 ERP 同步'};}
  listOrders({q='',status='',sort='newest',page=1,pageSize=30}={}) {
    let rows=this.db.prepare('SELECT * FROM orders').all().map(r=>this.decode(r));
    const needle=String(q).toLocaleLowerCase();
    rows=rows.filter(o=>(!needle||[o.orderNo,o.requester,o.productCode,o.productName,o.batch,o.notes,o.snapshot.material?.name].filter(Boolean).some(s=>String(s).toLocaleLowerCase().includes(needle)))&&(!status||(status==='未匹配'?!o.snapshot.latestStatus:o.snapshot.latestStatus===status)));
    rows.sort(sort==='due'?(a,b)=>(a.dueMode==='asap'?'0000':a.dueDate||'9999').localeCompare(b.dueMode==='asap'?'0000':b.dueDate||'9999')||b.id-a.id:sort==='progress'?(a,b)=>a.snapshot.progress-b.snapshot.progress||b.id-a.id:(a,b)=>b.id-a.id);
    const total=rows.length;pageSize=Math.max(1,Math.min(100,Number(pageSize)||30));page=Math.max(1,Math.min(Math.ceil(total/pageSize)||1,Number(page)||1));
    return {rows:rows.slice((page-1)*pageSize,page*pageSize),total,page,pageSize,pages:Math.max(1,Math.ceil(total/pageSize))};
  }
  overview() {
    const rows=this.listOrders({pageSize:100}).rows;const all=this.db.prepare('SELECT payload FROM orders').all().map(r=>JSON.parse(r.payload));
    const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    return {total:all.length,active:all.filter(x=>x.snapshot.progress>0&&x.snapshot.progress<100).length,completed:all.filter(x=>x.snapshot.progress===100).length,
      overdue:all.filter(x=>(x.deliveryDate||x.dueDate)&& (x.deliveryDate||x.dueDate)<today&&x.snapshot.progress<100).length,missingBom:all.filter(x=>!x.snapshot.bom.length).length,
      materials:this.items('materials').length,documents:this.items('documents').length,lastImport:this.meta('lastImport'),sampleCount:rows.length};
  }
  previewImport({kind,format='json',text:raw}) {
    if(!normalizers[kind])throw new AppError('不支持的导入类型');
    if(typeof raw!=='string'||raw.length>10*1024*1024)throw new AppError('导入内容为空或超过 10MB');
    let input;
    if(format==='csv')input=parseCsv(raw);else if(format==='json'){try{input=JSON.parse(raw);}catch{throw new AppError('JSON 格式错误');}}else throw new AppError('不支持的导入格式');
    if(!Array.isArray(input)||!input.length||input.length>20000)throw new AppError('导入必须为 1–20000 条记录的数组');
    const rows=input.map((r,i)=>{try{
      if(!r||typeof r!=='object'||Array.isArray(r))throw new AppError('记录格式错误');
      const v={...r};
      if(format==='csv'&&kind==='documents'&&v.cancelled!=null){if(!['','true','false','1','0'].includes(v.cancelled))throw new AppError('撤销字段须为 true/false/1/0');v.cancelled=['true','1'].includes(v.cancelled);}
      return normalizers[kind](v);
    }catch(e){throw new AppError(`第 ${i+1} 条：${e.message}`);}});
    if(kind!=='orders'){const keys=rows.map(r=>keyOf(kind,r));if(new Set(keys).size!==keys.length)throw new AppError('本批次含重复主键，请合并或移除重复记录');}
    const hash=createHash('sha256').update(JSON.stringify({kind,rows})).digest('hex');
    const existing=kind==='orders'?rows.filter(row=>this.db.prepare('SELECT id FROM orders WHERE request_key=?').get(orderImportKey(row))).length:0;
    return {kind,rows,count:rows.length,existing,newCount:rows.length-existing,hash,mode:kind==='bom'?'按成品替换本批次涉及的 BOM 全部子件':kind==='orders'?`逐行防重复：新增 ${rows.length-existing} 条，已存在 ${existing} 条`:'按主键更新，不删除其他记录',source:'import'};
  }
  importData(body) {
    const preview=this.previewImport(body);return this.transaction(()=>{
      const time=now();
      if(preview.kind==='bom'){
        const products=new Set(preview.rows.map(r=>r.productCode));
        for(const item of this.db.prepare('SELECT item_key,payload FROM items WHERE kind=?').all('bom'))if(products.has(JSON.parse(item.payload).productCode))this.db.prepare('DELETE FROM items WHERE kind=? AND item_key=?').run('bom',item.item_key);
      }
      for(const [i,row] of preview.rows.entries()){
        if(preview.kind==='orders')this.createOrder(row,orderImportKey(row));
        else this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?,?,?,?)').run(preview.kind,keyOf(preview.kind,row),JSON.stringify(row),'import',time);
      }
      const result={kind:preview.kind,count:preview.count,hash:preview.hash,at:time,source:'import'};this.meta('lastImport',result);this.log('导入数据',result);this.syncAll();return result;
    });
  }
  backup() {return {schema:'machining-scheduler',version:1,exportedAt:now(),orders:this.db.prepare('SELECT * FROM orders ORDER BY id').all().map(r=>({...r,payload:JSON.parse(r.payload)})),items:this.db.prepare('SELECT * FROM items ORDER BY kind,item_key').all().map(r=>({...r,payload:JSON.parse(r.payload)})),audit:this.db.prepare('SELECT * FROM audit ORDER BY id').all().map(r=>({...r,detail:JSON.parse(r.detail)})),meta:this.db.prepare('SELECT * FROM meta').all()};}
  restore(backup) {
    if(!backup||backup.schema!=='machining-scheduler'||backup.version!==1||!Array.isArray(backup.orders)||!Array.isArray(backup.items)||backup.orders.length>20000||backup.items.length>60000)throw new AppError('备份格式或版本不支持');
    const ids=new Set(),requests=new Set(),itemKeys=new Set();
    const orders=backup.orders.map(r=>{
      if(!Number.isSafeInteger(r.id)||r.id<1||ids.has(r.id)||!Number.isSafeInteger(r.version)||r.version<1||!r.request_key||requests.has(r.request_key)||!Number.isFinite(Date.parse(r.created_at))||!Number.isFinite(Date.parse(r.updated_at)))throw new AppError('备份订单元数据错误或重复');
      ids.add(r.id);requests.add(r.request_key);const payload=validateOrder(r.payload);
      if(r.payload.erpDocuments){if(!Array.isArray(r.payload.erpDocuments))throw new AppError('备份 ERP 单据格式错误');payload.erpDocuments=r.payload.erpDocuments.map(d=>({...normalizeDocument(d),source:'s7',sourceTime:d.sourceTime,sourceBatch:text(d.sourceBatch),productionId:text(d.productionId),productionRowId:text(d.productionRowId)}));payload.erpMessage=text(r.payload.erpMessage);payload.erpError=text(r.payload.erpError)||null;}
      if(r.payload.erpMessage!=null)payload.erpMessage=text(r.payload.erpMessage);
      if(r.payload.erpError!=null)payload.erpError=text(r.payload.erpError)||null;
      return {...r,payload};
    });
    const items=backup.items.map(r=>{
      if((!normalizers[r.kind]&&r.kind!=='purchase')||r.kind==='orders'||!['import','s7'].includes(r.source)||!Number.isFinite(Date.parse(r.source_time)))throw new AppError('备份来源数据错误');
      const payload=(r.kind==='purchase'?normalizePurchase:normalizers[r.kind])(r.payload),key=r.kind==='purchase'?payload.code:keyOf(r.kind,payload),full=JSON.stringify([r.kind,key]);
      if(r.kind==='materials'&&r.source==='s7'){
        if(r.payload.s7Missing!=null){if(typeof r.payload.s7Missing!=='boolean')throw new AppError('备份物料缺失状态错误');payload.s7Missing=r.payload.s7Missing;}
        if(r.payload.s7BomStatus!=null){if(!['available','missing','not-queried','forbidden','ambiguous','error'].includes(r.payload.s7BomStatus))throw new AppError('备份 BOM 状态错误');payload.s7BomStatus=r.payload.s7BomStatus;}
        if(r.payload.s7BomError!=null)payload.s7BomError=text(r.payload.s7BomError,500);
      }
      if(key!==r.item_key||itemKeys.has(full))throw new AppError('备份数据主键错误或重复');itemKeys.add(full);return {...r,payload};
    });
    const audit=backup.audit??[];const meta=backup.meta??[];
    if(!Array.isArray(audit)||!Array.isArray(meta))throw new AppError('备份审计格式错误');
    for(const a of audit)if(!Number.isFinite(Date.parse(a.at))||typeof a.action!=='string'||typeof a.detail!=='object'||a.detail===null)throw new AppError('备份审计记录错误');
    for(const m of meta){if(!['lastImport','demoSeeded'].includes(m.key))throw new AppError('备份含不支持的配置');try{const v=JSON.parse(m.value);if(m.key==='demoSeeded'&&typeof v!=='boolean')throw new Error();}catch{throw new AppError('备份配置格式错误');}}
    const safetyBackup=join(dirname(this.path),'backups',`before-restore-${Date.now()}-${randomUUID().slice(0,6)}.json`);
    mkdirSync(dirname(safetyBackup),{recursive:true});writeFileSync(safetyBackup,JSON.stringify(this.backup(),null,2));
    return this.transaction(()=>{
      this.db.exec('DELETE FROM orders; DELETE FROM items; DELETE FROM audit; DELETE FROM meta;');
      for(const r of items)this.db.prepare('INSERT INTO items VALUES(?,?,?,?,?)').run(r.kind,r.item_key,JSON.stringify(r.payload),r.source,r.source_time);
      for(const r of orders){r.payload.snapshot=this.snapshot({...r.payload,id:r.id});this.db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?)').run(r.id,JSON.stringify(r.payload),r.created_at,r.updated_at,r.version,r.request_key);}
      for(const a of audit)this.db.prepare('INSERT INTO audit(at,action,detail) VALUES(?,?,?)').run(a.at,a.action,JSON.stringify(a.detail));
      for(const m of meta)this.db.prepare('INSERT INTO meta VALUES(?,?)').run(m.key,m.value);
      this.log('恢复备份',{orders:orders.length,items:items.length});return {orders:orders.length,items:items.length,safetyBackup};
    });
  }
}

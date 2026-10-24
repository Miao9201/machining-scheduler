import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { AppError } from './domain.js';
import { writeCsv } from './csv.js';
import { S7,safeS7Error,S7_BASE_URL } from './s7.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const BACKUP_LIMIT=128*1024*1024;
const templates={
  materials:[{code:'DEMO-P001',name:'演示成品',spec:'DN80'}],
  bom:[{productCode:'DEMO-P001',materialCode:'DEMO-M001',name:'演示毛坯',spec:'Φ80',usage:1}],
  documents:[{id:'DEMO-DOC001',documentNo:'DEMO-001',orderNo:'DEMO-ORDER001',productCode:'DEMO-P001',batch:'DEMO-B01',chain:'production',materialCode:'',type:'检验单',occurredAt:'2026-10-23T08:00:00+08:00',quantity:10,scrap:1,cancelled:false}],
  orders:[{requester:'备料',orderNo:'DEMO-ORDER001',productCode:'DEMO-P001',productName:'演示成品',quantity:10,batch:'DEMO-B01',dueMode:'date',dueDate:'2026-11-01',deliveryDate:'',drawingStatus:'已评审',blankAvailable:'',cuttingSize:'',completionNote:'',notes:'导入模板示例，请替换为实际数据'}]
};
function seed(store) {
  if(store.meta('demoSeeded'))return;
  for(const kind of ['materials','bom','orders','documents'])store.importData({kind,format:'json',text:JSON.stringify(templates[kind])});
  store.createOrder({...templates.orders[0],orderNo:'DEMO-ORDER002',batch:'DEMO-B02',quantity:50,dueMode:'asap',dueDate:null,notes:'演示：相同产品、不同订单，不会串入上一张订单的检验单'},'demo2');
  store.createOrder({...templates.orders[0],orderNo:'DEMO-ORDER003',productCode:'DEMO-P002',productName:'待建 BOM 示例',quantity:25,notes:'演示：物料和 BOM 缺失不会显示为零'},'demo3');
  store.meta('demoSeeded',true);
}
function exportRow(o,index) {
  const s=o.snapshot,bom=s.bom;
  return {'序号':index+1,'记录ID':o.id,'下单人':o.requester,'订单号':o.orderNo,'批次':o.batch,'下单时间':o.createdAt,'需求时间':o.dueMode==='asap'?'尽快':o.dueMode==='other'?'其他':o.dueDate,'计划时间':'','完成时间':s.completedAt,
    '成品编码':o.productCode,'成品名称':s.material?.name||o.productName,'成品规格':s.material?.spec??'','需求数量':o.quantity,'实际生产数量':s.actualQuantity,'报废数量':s.scrapQuantity,'最新单据状态':s.latestStatus,'进度':s.progress+'%',
    '毛坯编码':bom.map(b=>b.materialCode).join(' / '),'毛坯名称':bom.map(b=>b.name).join(' / '),'毛坯规格':bom.map(b=>b.spec).join(' / '),'单个用量':bom.map(b=>b.usage).join(' / '),'采购状态':s.purchaseStatus,
    '采购范围':s.purchaseScope==='material'?'物料级 · 非本单专属':'订单资料导入','各毛坯采购状态':bom.map(b=>`${b.materialCode}: ${s.purchaseByMaterial?.[b.materialCode]||'未匹配'}`).join(' / '),'采购查询提示':(s.purchaseErrors||[]).map(x=>`${x.materialCode} / ${x.stage}: ${x.error}`).join(' / '),
    '图纸情况':o.drawingStatus,'完成情况':o.completionNote,'毛坯有无':o.blankAvailable,'抛料尺寸':o.cuttingSize,'订单交期':o.deliveryDate,'备注':o.notes,'数据来源':s.source==='s7'?'S7 资料快照':'本地导入 / 手工，非实时','最近关联':s.syncedAt,'生产查询提示':s.erpError,'BOM查询提示':s.bomError};
}
export function createApp({dataDir=process.env.DATA_DIR||join(root,'data'),demo=false}={}) {
  const store=new Store(join(resolve(dataDir),'app.sqlite'));const s7=new S7(resolve(dataDir));if(demo)seed(store);
  const refreshProduct=async code=>{
    const result=await s7.lookup(code);store.cacheS7(code,result);
    const queryErrors=result.bomError?[{code,stage:'BOM',error:result.bomError}]:[];
    if(result.bomStatus==='available')for(const materialCode of new Set(result.bom.map(b=>b.materialCode))){
      let purchase;
      try{purchase=await s7.purchase(materialCode);}catch(err){purchase={code:materialCode,documents:[],errors:[{stage:'采购查询',error:safeS7Error(err)}],queriedAt:new Date().toISOString()};}
      store.cachePurchase(purchase);queryErrors.push(...purchase.errors.map(x=>({code,materialCode,...x})));
    }
    return {...store.material(code),queryErrors};
  };
  const refreshOrder=async order=>{
    if(!order.productionId||!s7.status().connected)return order;
    try{return store.cacheProduction(order.id,await s7.production(order),null,order);}
    catch(err){if(err.status===409&&err.message.includes('查询期间'))throw err;return store.cacheProduction(order.id,null,safeS7Error(err),order);}
  };
  const server=http.createServer(async(req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const host=req.headers.host||'';
      if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host))throw new AppError('仅允许本机访问',403);
      const url=new URL(req.url,`http://${host}`),path=url.pathname;
      const mutation=['POST','PATCH','DELETE'].includes(req.method);
      if(mutation){
        if(req.headers.origin&&!new Set([`http://${host}`,`http://localhost:${server.address().port}`,`http://127.0.0.1:${server.address().port}`]).has(req.headers.origin))throw new AppError('拒绝外站写入',403);
        if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new AppError('请使用 JSON 格式提交',415);
      }
      let body;
      if(mutation){let size=0;const chunks=[];const limit=path==='/api/restore'?BACKUP_LIMIT:16*1024*1024;for await(const chunk of req){size+=chunk.length;if(size>limit)throw new AppError(`请求超过 ${limit/1024/1024}MB`,413);chunks.push(chunk);}try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new AppError('JSON 格式错误');}}
      if(path==='/api/overview'&&req.method==='GET')return json(200,{...store.overview(),demo,appId:'machining-scheduler',version:'1.0.1',s7:s7.status()});
      if(path==='/api/orders'&&req.method==='GET')return json(200,store.listOrders(Object.fromEntries(url.searchParams)));
      if(path==='/api/orders'&&req.method==='POST')return json(201,await refreshOrder(store.createOrder(body,req.headers['idempotency-key'])));
      const orderMatch=path.match(/^\/api\/orders\/(\d+)(\/sync)?$/);
      if(orderMatch){const id=Number(orderMatch[1]);
        if(orderMatch[2]&&req.method==='POST'){
          const order=store.getOrder(id),queryErrors=[];
          if(s7.status().connected)try{queryErrors.push(...(await refreshProduct(order.productCode)).queryErrors);}catch(err){queryErrors.push({code:order.productCode,error:safeS7Error(err)});}
          return json(200,{...await refreshOrder(store.syncOrder(id)),queryErrors});
        }
        if(!orderMatch[2]&&req.method==='GET')return json(200,store.getOrder(id));
        if(!orderMatch[2]&&req.method==='PATCH')return json(200,await refreshOrder(store.updateOrder(id,body)));
        if(!orderMatch[2]&&req.method==='DELETE'){store.deleteOrder(id,body.version);return json(200,{ok:true});}
      }
      if(path==='/api/sync'&&req.method==='POST'){
        const errors=[];
        if(s7.status().connected){const codes=[...new Set(store.db.prepare('SELECT payload FROM orders').all().map(r=>JSON.parse(r.payload).productCode))];for(const code of codes)try{errors.push(...(await refreshProduct(code)).queryErrors);}catch(err){errors.push({code,error:safeS7Error(err)});}}
        const result=store.transaction(()=>store.syncAll());
        if(s7.status().connected)for(const r of store.db.prepare('SELECT id FROM orders').all()){const order=store.getOrder(r.id);if(order.productionId){const updated=await refreshOrder(order);if(updated.snapshot.erpError)errors.push({id:r.id,error:updated.snapshot.erpError});}}
        return json(200,{...result,errors,message:s7.status().connected?`已查询 S7 物料、BOM 和已关联生产单，${errors.length} 项失败；采购状态查询 BOM 毛坯最近采购进度（物料级）`:result.message});
      }
      if(path.startsWith('/api/materials/')&&req.method==='GET'){
        const code=decodeURIComponent(path.slice(15));return json(200,s7.status().connected?await refreshProduct(code):store.material(code));
      }
      if(path==='/api/s7/connect'&&req.method==='POST'){if(demo)throw new AppError('请在正式工作库连接 S7，演示库不接入真实数据');const result=await s7.connect(body);store.log('连接 S7',{company:result.company});return json(200,result);}
      if(path==='/api/s7/disconnect'&&req.method==='POST'){await s7.disconnect(body.forget===true);store.log('断开 S7',{forgotten:body.forget===true});return json(200,s7.status());}
      if(path==='/api/s7/lookup'&&req.method==='POST')return json(200,await refreshProduct(body.productCode));
      if(path==='/api/s7/production-candidates'&&req.method==='POST')return json(200,{rows:await s7.candidates(body.productCode)});
      if(path==='/api/import/preview'&&req.method==='POST'){const p=store.previewImport(body);return json(200,{...p,rows:p.rows.slice(0,5)});}
      if(path==='/api/import'&&req.method==='POST')return json(200,store.importData(body));
      if(path==='/api/import/template'&&req.method==='GET'){
        const kind=url.searchParams.get('kind');if(!templates[kind])throw new AppError('模板类型错误');
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${kind}-template.csv"`});return res.end(writeCsv(templates[kind],Object.keys(templates[kind][0])));
      }
      if(path==='/api/audit'&&req.method==='GET')return json(200,store.audit());
      if(path==='/api/integration'&&req.method==='GET')return json(200,{...s7.status(),mode:s7.status().connected?'s7':'import',endpoint:S7_BASE_URL,message:s7.status().connected?'S7 物料与 BOM 已连接；选择生产加工单后可同步生产、报检、最终检验和入库，采购状态查询 BOM 毛坯最近采购进度（物料级）':'可使用本地导入资料，或连接 S7 实时查询物料、BOM 和已关联生产单',lastImport:store.meta('lastImport'),counts:{materials:store.items('materials').length,bom:store.items('bom').length,documents:store.items('documents').length}});
      if(path==='/api/backup'&&req.method==='GET'){
        const content=JSON.stringify(store.backup());if(Buffer.byteLength(content)>BACKUP_LIMIT-1024)throw new AppError('备份超过 128MB 的导出与恢复上限，请保留本机 data 目录并联系维护人员',413);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="machining-backup-${Date.now()}.json"`});return res.end(content);
      }
      if(path==='/api/restore'&&req.method==='POST'){if(body.confirm!=='恢复')throw new AppError('请先确认恢复操作');return json(200,store.restore(body.backup));}
      if(path==='/api/export.csv'&&req.method==='GET'){
        const query=Object.fromEntries(url.searchParams);const first=store.listOrders({...query,page:1,pageSize:100}),all=[...first.rows];
        for(let page=2;page<=first.pages;page++)all.push(...store.listOrders({...query,page,pageSize:100}).rows);
        const rows=all.map(exportRow),headers=Object.keys(exportRow({id:0,createdAt:'',snapshot:{bom:[]}},0));
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="machining-orders.csv"'});return res.end(writeCsv(rows,headers));
      }
      const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
      if(req.method==='GET'&&files[path]){
        const file=join(root,'public',files[path]);if(!existsSync(file))throw new AppError('页面尚未准备好',503);
        res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});return res.end(readFileSync(file));
      }
      throw new AppError('接口或页面不存在',404);
    }catch(e){json(e.status||500,{error:e.status?e.message:'操作失败，请重试或检查本地服务'});if(!e.status)console.error('[server]',e.code||e.name);}
  });
  server.on('close',()=>s7.close());
  return {server,store,s7};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const demo=process.argv.includes('--demo');const port=Number(process.env.PORT||(demo?18788:18787));
  const dataDir=process.env.DATA_DIR||join(root,demo?'data-demo':'data');
  const {server,store}=createApp({dataDir,demo});
  server.listen(port,'127.0.0.1',()=>console.log(`机加总表${demo?'（演示库）':''} http://127.0.0.1:${port}`));
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`端口 ${port} 已占用，请打开现有页面或设置 PORT`:'服务启动失败');store.close();process.exitCode=1;});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));
}

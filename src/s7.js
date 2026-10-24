import { existsSync,readFileSync,writeFileSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppError,normalizeMaterial,normalizeBom,normalizeDocument,timestamp,text } from './domain.js';

export const S7_BASE_URL=(process.env.S7_BASE_URL||'http://127.0.0.1:18088').replace(/\/+$/,'');
const BASE=S7_BASE_URL;
export function safeS7Error(err){return err instanceof AppError?err.message:/timeout/i.test(err?.message||'')?'S7 请求超时，保留上次成功资料':'S7 查询异常，保留上次成功资料';}
export function s7Time(input) {
  if(!input)return null;
  const m=String(input).match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}:\d{2}))?/);
  return m?timestamp(`${m[1]}T${m[2]||'00:00:00'}+08:00`):null;
}
export function mapMaterial(code,rows) {
  const exact=rows.filter(r=>r.invCode===code);
  if(exact.length>1)throw new AppError('S7 存货编码重复，需在源系统核对',409);
  if(!exact.length)return null;
  const r=exact[0];return {...normalizeMaterial({code:r.invCode,name:r.invName,spec:r.spec}),erpId:r.id};
}
export function mapBom(code,data) {
  const headers=(data.rows||[]).filter(r=>r.inventoryCode===code&&r.bomType===0&&r.billState===2&&!r.isClose&&!r.isHistory);
  if(!headers.length)return {status:'missing',rows:[]};
  if(headers.length>1)throw new AppError('存在多个生效主 BOM，需先明确版本，未自动选取',409);
  const h=headers[0];if(!(h.productQuantum>0))throw new AppError('BOM 母件生产数量无效，无法折算单个用量');
  const body=(data.DetailTableList||[]).filter(r=>r.bomId===h.id);
  if(!body.length)throw new AppError('BOM 头与明细未对应或明细为空，未覆盖已有 BOM');
  const rows=body.map(r=>({...normalizeBom({productCode:code,materialCode:r.inventoryCode,name:r.inventoryName,spec:r.inventorySpec,usage:r.quantum/h.productQuantum,sourceRowKey:r.id}),erpBomId:h.id,erpRowId:r.id,bomNo:h.billNo,version:h.version||''}));
  // 同物料不同部位的 BOM 行需要全部保留，仓储键以 ERP 行 ID 区分。
  return {status:'available',rows,bomId:h.id};
}
export function mapProduction(order,root,{issues=[],notices=[],inspections=[],receipts=[]}={}) {
  if(root.h_id!==order.productionId||root.id!==order.productionRowId||root.inventorycode!==order.productCode)throw new AppError('S7 生产加工单主键或成品编码不匹配',409);
  const time=new Date().toISOString(),docs=new Map();
  const add=(type,id,no,at,extra={})=>{
    if(!id)throw new AppError(`${type}缺少行主键，未替换已有关联快照`);
    if(!at)throw new AppError(`${type}缺少发生时间，未替换已有关联快照`);
    const raw={id:`s7:${type}:${id}`,orderNo:order.orderNo||`LOCAL-${order.id}`,productCode:order.productCode,batch:order.batch||'',chain:'production',type,documentNo:no,occurredAt:at,cancelled:false,...extra};
    const doc={...normalizeDocument(raw),source:'s7',sourceTime:time,sourceBatch:extra.sourceBatch||'',productionId:root.h_id,productionRowId:root.id};
    const old=docs.get(doc.id);if(old&&(old.quantity!==doc.quantity||old.scrap!==doc.scrap))throw new AppError('同一检验行出现不一致数量，未汇总',409);
    docs.set(doc.id,doc);
  };
  const lot=r=>!order.batch||r.batchcode===order.batch||(!r.batchcode&&root.batchcode===order.batch);
  if(root.h_billstate===2)add('生产加工单',root.id,root.h_billno,s7Time(root.h_createTs||root.h_billdate));
  for(const r of issues)if(r.billstate===2&&r.pmorderid===root.h_id&&r.pmorderbid===root.id&&r.billtype==='PM006')add('材料出库单',r.stockbillbid,r.billno,s7Time(r.stockbilldate),{materialCode:r.inventorycode,sourceBatch:r.batchcode,timePrecision:'date'});
  for(const r of notices)if(r.h_billstate===2&&r.productionorderid===root.h_id&&r.productionorderrowid===root.id&&r.inventorycode===order.productCode&&lot(r))add('报检单',r.id,r.h_billno,s7Time(r.h_createTs||r.h_billdate),{sourceBatch:r.batchcode});
  for(const r of inspections)if(r.h_billstate===2&&r.purchaseorderid===root.h_id&&r.purchaseorderrowid===root.id&&r.inventorycode===order.productCode&&r.frombilltypename==='生产报检单'&&lot(r))add('检验单',r.id,r.h_billno,s7Time(r.h_createTs||r.h_billdate),{quantity:r.quantum,scrap:r.wastequantum,sourceBatch:r.batchcode});
  for(const r of receipts)if(r.h_billstate===2&&r.productionorderid===root.h_id&&r.productionorderrowid===root.id&&r.inventorycode===order.productCode&&lot(r))add('产成品入库单',r.id,r.h_billno,s7Time(r.h_createTs||r.h_billdate),{sourceBatch:r.batchcode});
  return [...docs.values()];
}
export function mapPurchase(code,{stages=[],inspections=[]}={}) {
  const docs=new Map(),sourceTime=new Date().toISOString();
  const add=(type,id,no,at)=>{
    if(!id||!at)throw new AppError('采购单据缺少主键或时间，未当作成功结果');
    const doc={...normalizeDocument({id:`s7:${type}:${id}`,orderNo:`MATERIAL:${code}`,productCode:code,batch:'',materialCode:code,chain:'purchase',type,documentNo:no,occurredAt:at}),source:'s7',sourceTime,scope:'material'};docs.set(doc.id,doc);
  };
  for(const r of stages)if(r.billState===2&&r.materialCode===code)add(r.type,r.id,r.documentNo,r.occurredAt);
  for(const r of inspections)if(r.h_billstate===2&&r.inventorycode===code&&r.frombilltypename==='采购报检单')add('检验单',r.id,r.h_billno,s7Time(r.h_createTs||r.h_billdate));
  return [...docs.values()];
}
export async function protectSecret(value,decrypt=false) {
  if(process.platform!=='win32')throw new AppError('保存账号目前仅支持 Windows，其他系统请使用临时连接');
  const script=`[Console]::InputEncoding=New-Object System.Text.UTF8Encoding; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; $v=[Console]::In.ReadToEnd(); `+(decrypt?`$s=ConvertTo-SecureString -String $v.Trim(); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}`:`$s=ConvertTo-SecureString -String $v -AsPlainText -Force; [Console]::Write((ConvertFrom-SecureString -SecureString $s))`);
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,PSModulePath:join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')},stdio:['pipe','pipe','pipe']});let output='';
    child.stdout.setEncoding('utf8');child.stdout.on('data',d=>output+=d);child.stderr.resume();
    child.on('error',()=>reject(new AppError('Windows 凭据保护不可用')));child.on('exit',code=>code===0?resolve(output.replace(/^\uFEFF/,'')):reject(new AppError('无法读取或保存受保护账号')));child.stdin.end(value);
  });
}
export class S7 {
  constructor(dataDir){this.secretFile=join(dataDir,'s7-credentials.dpapi');this.browser=null;this.page=null;this.frames=new Map();this.error=null;this.lastCheckedAt=null;this.company=null;this.pending=Promise.resolve();}
  status(){return {connected:!!this.page&&!this.error,hasSavedCredentials:existsSync(this.secretFile),company:this.company,lastCheckedAt:this.lastCheckedAt,error:this.error,phase:this.phase||null,capabilities:{materials:true,bom:true,production:true,inspection:true,purchase:true}};}
  async close(){await this.browser?.close().catch(()=>{});this.browser=null;this.page=null;this.frames.clear();}
  async disconnect(forget=false){await this.close();if(forget&&existsSync(this.secretFile))unlinkSync(this.secretFile);}
  serial(fn){const work=this.pending.then(fn,fn);this.pending=work.catch(()=>{});return work;}
  async connect({username,password,company,allowForce=false,remember=false}={}){
    return this.serial(async()=>{
      if(!username||!password){
        if(!existsSync(this.secretFile))throw new AppError('请填写 S7 用户名和密码');
        let saved;try{saved=JSON.parse(await protectSecret(readFileSync(this.secretFile,'utf8'),true));}catch{throw new AppError('保存的账号无法解密，请重新填写');}
        username=saved.username;password=saved.password;company=saved.company;
      }
      username=text(username,200);if(typeof password!=='string'||password.length>500)throw new AppError('账号格式错误');
      await this.close();
      try{
        const {chromium}=await import('playwright');
        const candidates=[process.env.CHROME_PATH,process.env['PROGRAMFILES']&&join(process.env['PROGRAMFILES'],'Google','Chrome','Application','chrome.exe'),process.env['PROGRAMFILES(X86)']&&join(process.env['PROGRAMFILES(X86)'],'Microsoft','Edge','Application','msedge.exe')].filter(Boolean);
        const executablePath=candidates.find(existsSync);if(!executablePath)throw new AppError('需要安装 Chrome 或 Edge 浏览器才能连接 S7');
        this.browser=await chromium.launch({headless:true,executablePath});const context=await this.browser.newContext({viewport:{width:1440,height:1000}});
        this.browser.on('disconnected',()=>{this.page=null;this.frames.clear();});
        await context.route('**/*',route=>{
          const u=new URL(route.request().url());
          if(u.origin===BASE&&/\/(save|delete|remove|approve|unapprove|insert|update|import)[^/]*\.(do|json)$/i.test(u.pathname))return route.abort();
          return route.continue();
        });
        this.phase='打开登录页';const page=await context.newPage();page.setDefaultTimeout(15000);await page.goto(BASE+'/',{waitUntil:'domcontentloaded',timeout:20000});
        this.phase='填写账号';await page.locator('#userName').fill(username);await page.locator('#password').fill(password);await page.locator('#password').press('Tab');
        this.phase='读取账套';await page.waitForFunction(()=>document.querySelector('#company')?.options.length>0,{},{timeout:15000});
        if(company){const options=await page.locator('#company option').evaluateAll(ns=>ns.map(n=>({value:n.value,text:n.textContent})));const found=options.find(o=>o.text===company||o.value===company);if(!found)throw new AppError('未找到指定账套');await page.locator('#company').selectOption(found.value);}
        this.company=await page.locator('#company option:checked').textContent();
        const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);await page.locator('#time').evaluate((input,value)=>input.value=value,today);
        this.phase='提交登录';await page.locator('#loginBtn').click();
        await page.waitForFunction(()=>location.pathname.includes('/main/Main.htm')||document.body.innerText.includes('是否强制登录')||/密码错误|用户不存在|账号不存在|密码不正确|短信验证码/.test(document.body.innerText),{},{timeout:20000});
        this.phase='处理登录结果';if(!page.url().includes('/main/Main.htm')){
          const body=await page.locator('body').innerText();
          if(body.includes('是否强制登录')){if(!allowForce)throw new AppError('S7 账号正在其他位置使用，请勾选允许本次强制登录后重试',409);await page.getByText('确定',{exact:true}).click();}
          else if(body.includes('短信验证码'))throw new AppError('该账号需要短信验证码，请使用无需短信的专用只读账号',401);
          else throw new AppError('S7 账号或密码校验失败',401);
        }
        this.phase='等待工作台';await page.waitForURL('**/main/Main.htm*',{timeout:20000});this.page=page;this.phase='已连接';this.error=null;this.lastCheckedAt=new Date().toISOString();
        if(remember)writeFileSync(this.secretFile,await protectSecret(JSON.stringify({username,password,company:this.company})),{mode:0o600});
        return this.status();
      }catch(err){await this.close();const message=err instanceof AppError?err.message:/timeout/i.test(err.message)?'S7 连接超时，请检查网络、账号与账套':'S7 连接失败，请检查网络和浏览器运行条件';this.error=message+'（'+this.phase+'）';throw new AppError(this.error,err.status||503);}
    });
  }
  async frame(menu,path){
    if(!this.page)throw new AppError('S7 未连接，请先在数据与接入中登录',503);
    const cached=this.frames.get(path);if(cached&&!cached.isDetached())return cached;
    const existing=this.page.frames().find(f=>f.url().split('?')[0]===BASE+path);
    if(existing){this.frames.set(path,existing);return existing;}
    const item=this.page.getByText(menu,{exact:true}).first();if(!await item.count())throw new AppError(`当前账号没有“${menu}”菜单权限`,403);
    await item.dispatchEvent('click');
    for(let i=0;i<60;i++){
      const f=this.page.frames().find(f=>f.url().split('?')[0]===BASE+path);if(f){await f.waitForLoadState('domcontentloaded');this.frames.set(path,f);return f;}
      await this.page.waitForTimeout(200);
    }
    throw new AppError(`${menu}页面未能打开，可能无模块权限或会话失效`,403);
  }
  async query(frame,condition,rows=100){
    const u=new URL(frame.url()),token=u.searchParams.get('token');
    const queryUrl=BASE+'/AdvanceQuery/advancedQuery.json'+(token?'?token='+encodeURIComponent(token):'');
    const response=await frame.page().request.post(queryUrl,{data:{condition,pageInfo:{page:1,rows}},headers:{Referer:frame.url()},timeout:20000});
    if(response.status()===403)throw new AppError('S7 拒绝查询，账号无权限或会话失效',403);
    let result;try{result=await response.json();}catch{throw new AppError('S7 返回登录页或非 JSON 内容，请重新连接',401);}
    if(!result.success||!result.responseData||!Array.isArray(result.responseData.rows))throw new AppError('S7 查询未成功，可能无模块权限或会话失效',403);
    if(result.responseData.total>rows)throw new AppError('查询结果超过单次上限，请缩小关联范围，未使用不完整结果',409);
    this.lastCheckedAt=new Date().toISOString();return result.responseData;
  }
  async productionRows(code){
    const frame=await this.frame('生产加工单列表','/report/PM0120/View.htm');
    const data=await this.query(frame,{q_beginBillDate:null,q_endBillDate:null,q_inventoryCode:code,funcNodeCode:'PM0120'},500);
    return [...new Map(data.rows.filter(r=>r.inventorycode===code).map(r=>[r.id,r])).values()];
  }
  async candidates(code){return this.serial(async()=>{
    return (await this.productionRows(text(code,200))).map(r=>({productionId:r.h_id,productionRowId:r.id,productionNo:r.h_billno,productCode:r.inventorycode,batch:r.batchcode||'',quantity:r.quantum,billDate:r.h_billdate,approved:r.h_billstate===2}));
  });}
  async production(order){return this.serial(async()=>{
    if(!order.productionId||!order.productionRowId)return {documents:[],message:'未选择 S7 生产加工单'};
    const rows=await this.productionRows(order.productCode),root=rows.find(r=>r.h_id===order.productionId&&r.id===order.productionRowId);
    if(!root)throw new AppError('关联的 S7 生产加工单已不存在或产品不匹配',409);
    const reports=[['材料出库明细表','/report/PM0200/View.htm',{q_beginBillDate:null,q_endBillDate:null,pmorderbillno:root.h_billno,funcNodeCode:'PM0200'}],['检验单列表','/report/QM2008/View.htm',{q_beginBillDate:null,q_endBillDate:null,q_inventoryCode:order.productCode,funcNodeCode:'QM2008'}],['产成品入库报表','/report/PM0160/View.htm',{q_beginBillDate:null,q_endBillDate:null,q_inventoryCode:order.productCode,funcNodeCode:'PM0160'}]];
    const results=[];
    for(const [menu,path,condition] of reports){const f=await this.frame(menu,path);results.push((await this.query(f,condition,1000)).rows);}
    const noticeFrame=await this.frame('生产报检单','/bill/QM1004/View.htm');
    const condition={beginBillDate:root.h_billdate,endBillDate:null,q_bodyInventoryCode:order.productCode,funcNodeCode:'QM1004'};
    const headData=await this.query(noticeFrame,condition,200),notices=[];
    for(const h of headData.rows.filter(h=>h.billState===2)){
      const data=await this.query(noticeFrame,{...condition,billNo:h.billNo},200);
      for(const b of data.DetailTableList||[])if(b.qmorderId===h.id&&b.fromBillType==='PM004')notices.push({id:b.id,inventorycode:b.inventoryCode,productionorderid:b.fromBillID,productionorderrowid:b.fromBillRowId,batchcode:b.batchCode,h_id:h.id,h_billno:h.billNo,h_billstate:h.billState,h_createTs:h.createTs,h_billdate:h.billDate});
    }
    const documents=mapProduction(order,root,{issues:results[0],inspections:results[1],receipts:results[2],notices});
    return {documents,queriedAt:new Date().toISOString(),productionNo:root.h_billno,message:order.batch?'按生产加工单主键、行主键和批次关联':'按生产加工单主键和行主键关联，汇总该行下游批次；仅最终生产检验计入数量'};
  });}
  async purchase(code){return this.serial(async()=>{
    code=text(code,200);const stages=[],errors=[];
    const specs=[['采购申请单','/bill/PUR0001/View.htm','PUR0001','PUR001','purchaseRequireId'],['采购订单','/bill/PUR0002/View.htm','PUR0002','PUR002','purchaseOrderId'],['采购报检单',null,'QM1002','QM1002','qmorderId'],['采购入库单','/bill/PUR0004/View.htm','PUR0004','PUR004','billId']];
    for(const [type,path,node,billType,parentKey] of specs)try{
      const frame=path?await this.frame(type,path):await this.frame('检验单列表','/report/QM2008/View.htm');
      const condition={beginBillDate:null,endBillDate:null,q_bodyInventoryCode:code,funcNodeCode:node,billType};
      const initial=await this.query(frame,condition,200),heads=initial.rows.filter(h=>h.billState===2&&!h.isRedBill).sort((a,b)=>Date.parse(s7Time(b.createTs||b.billDate))-Date.parse(s7Time(a.createTs||a.billDate)));
      for(const h of heads){
        const data=await this.query(frame,{...condition,billNo:h.billNo},200),body=(data.DetailTableList||[]).filter(b=>b.inventoryCode===code&&b[parentKey]===h.id);
        if(!body.length)continue;
        for(const b of body)stages.push({id:b.id,type,documentNo:h.billNo,billState:h.billState,materialCode:code,occurredAt:s7Time(h.createTs||h.billDate)});
        break;
      }
    }catch(err){errors.push({stage:type,error:err instanceof AppError?err.message:'采购查询失败或超时'});}
    let inspections=[];
    try{const frame=await this.frame('检验单列表','/report/QM2008/View.htm');inspections=(await this.query(frame,{q_beginBillDate:null,q_endBillDate:null,q_inventoryCode:code,funcNodeCode:'QM2008'},1000)).rows;}catch(err){errors.push({stage:'检验单',error:err instanceof AppError?err.message:'采购检验查询失败'});}
    return {code,documents:mapPurchase(code,{stages,inspections}),errors,queriedAt:new Date().toISOString(),scope:'material'};
  });}
  async lookup(code){return this.serial(async()=>{
    code=text(code,200);if(!code)throw new AppError('成品编码不能为空');
    try{
      const inventory=await this.frame('存货档案','/bd/DOC000030/View.htm');
      const data=await this.query(inventory,{invCode:code,funcNodeCode:'DOC000030'});
      const material=mapMaterial(code,data.rows);
      let bom={status:'not-queried',rows:[]},bomError=null;
      if(material)try{const frame=await this.frame('BOM维护','/bill/PM0010/View.htm');const data=await this.query(frame,{q_headInventoryCode:code,q_isHistory:'false',billType:'PM002',funcNodeCode:'PM0010'},200);bom=mapBom(code,data);}catch(err){bomError=safeS7Error(err);bom={status:err.status===403?'forbidden':err.status===409?'ambiguous':'error',rows:[]};}
      this.error=null;return {material,bom:bom.rows,bomStatus:bom.status,bomError,source:'s7',queriedAt:new Date().toISOString(),materialStatus:material?'available':'missing'};
    }catch(err){const message=err instanceof AppError?err.message:/timeout/i.test(err.message)?'S7 查询超时，未覆盖上次成功资料':'S7 查询失败，未覆盖上次成功资料';this.error=message+'（'+this.phase+'）';throw new AppError(this.error,err.status||503);}
  });}
}

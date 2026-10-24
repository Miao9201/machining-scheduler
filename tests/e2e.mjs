import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {createApp} from '../src/server.js';

const dir=mkdtempSync(join(tmpdir(),'machining-ui-'));
const {server,store}=createApp({dataDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage({viewport:{width:1440,height:1050},acceptDownloads:true});
const errors=[];page.on('pageerror',err=>errors.push(err.message));
const results=[];
const check=(name,condition)=>{assert.ok(condition,name);results.push({name,passed:true});console.log('PASS '+name);};
const waitSaved=()=>page.waitForFunction(()=>!document.querySelector('#modal').open);
const input=(name)=>page.locator(`#order-form [name=${name}]`);
async function importViaUI(kind,rows){
  await page.locator('[data-action=import]').click();await page.locator('#import-kind').selectOption(kind);await page.locator('#import-format').selectOption('json');await page.locator('#import-text').fill(JSON.stringify(rows));await page.locator('#preview-import').click();await page.waitForFunction(()=>!document.querySelector('#commit-import').disabled);await page.locator('#commit-import').click();await waitSaved();await page.waitForTimeout(120);
}
try{
  await page.goto(base);await page.waitForSelector('#orders-table');
  await page.locator('[data-action=new]').first().click();await input('productCode').fill('T-P1');await input('productName').fill('浏览器验收零件');await input('quantity').fill('12.5');await input('requester').fill('下单人甲');await input('orderNo').fill('T-O1');await input('batch').fill('B1');await input('dueDate').fill('2026-11-01');await input('notes').fill('<script>alert("x")</script>');await page.getByRole('button',{name:'保存订单',exact:true}).click();await waitSaved();await page.waitForFunction(()=>document.querySelector('#orders-table').innerText.includes('T-O1'));
  check('表单新增成功并生成订单',store.listOrders().total===1);
  await page.reload();await page.waitForSelector('[data-detail]');check('页面重新打开后订单保留',(await page.locator('#orders-table').innerText()).includes('T-O1'));
  await importViaUI('materials',[{code:'T-P1',name:'浏览器验收零件',spec:'Φ40'}]);
  await importViaUI('bom',[{productCode:'T-P1',materialCode:'T-M1',name:'毛坯甲',spec:'钢',usage:1},{productCode:'T-P1',materialCode:'T-M2',name:'毛坯乙',spec:'铝',usage:2}]);
  const d={id:'T-D1',documentNo:'T-QC-001',orderNo:'T-O1',productCode:'T-P1',batch:'B1',chain:'production',type:'检验单',occurredAt:'2026-10-23T09:00:00+08:00',quantity:12,scrap:1};
  await importViaUI('documents',[d,{...d,id:'T-D2',documentNo:'T-NOTICE-001',type:'报检单',occurredAt:'2026-10-22T09:00:00+08:00',quantity:null,scrap:null},{...d,id:'T-PUR1',documentNo:'T-PUR-001',chain:'purchase',type:'检验单',materialCode:'T-M1',quantity:999,scrap:99}]);
  await page.locator('[data-detail]').first().click();await page.waitForSelector('#drawer[open]');const detail=await page.locator('#drawer').innerText();
  check('导入后显示 80% 生产进度与正确检验数量',store.listOrders().rows[0].snapshot.progress===80&&store.listOrders().rows[0].snapshot.actualQuantity===12&&detail.includes('T-QC-001'));
  check('一对多 BOM 和生产采购源单据均可追溯',detail.includes('毛坯甲')&&detail.includes('毛坯乙')&&detail.includes('T-PUR-001'));
  check('用户输入按文本显示，没有执行脚本',detail.includes('<script>alert("x")</script>'));
  await page.screenshot({path:resolve('test-results/detail.png'),fullPage:true}).catch(()=>{});await page.locator('.close-drawer').click();
  const quick=page.locator('.quick-row').first();await quick.locator('[name=requester]').fill('备料');await quick.locator('[name=productCode]').fill('T-P1');await quick.locator('[name=productCode]').press('Tab');await page.waitForFunction(()=>document.querySelector('.quick-row [name=productName]').value==='浏览器验收零件');await quick.locator('[name=quantity]').fill('3');await quick.locator('[data-save-quick]').click();await page.waitForFunction(()=>document.querySelector('.count').textContent.includes('2'));
  check('末尾快速录入查物料并持久保存',store.listOrders().total===2);
  await page.locator('[aria-label="搜索订单号、成品编码或名称"]').fill('T-O1');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.count').textContent.includes('1'));check('关键词筛选只返回匹配订单',(await page.locator('[data-detail]').count())===1);
  const dlPromise=page.waitForEvent('download');await page.locator('[data-action=export]').click();const download=await dlPromise;const downloaded=await download.path();check('CSV 导出为真实可下载文件',readFileSync(downloaded,'utf8').includes('浏览器验收零件'));
  await page.locator('[data-action=more]').click();const bp=page.waitForEvent('download');await page.locator('#download-backup').click();const backupDownload=await bp;const backupFile=await backupDownload.path();const backup=JSON.parse(readFileSync(backupFile,'utf8'));check('完整备份包含订单和全部源资料',backup.orders.length===2&&backup.items.length===6);await page.locator('[data-close]').click();
  await page.locator('[data-detail]').first().click();await page.locator('#edit-order').click();await input('quantity').fill('22');await page.getByRole('button',{name:'保存订单',exact:true}).click();await waitSaved();check('编辑结果写入数据库',store.getOrder(1).quantity===22);
  await page.locator('[data-action=more]').click();await page.locator('#open-restore').click();await page.locator('#restore-file').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.locator('#restore-confirm').fill('恢复');await page.locator('#commit-restore').click();await waitSaved();check('通过界面恢复备份后数量一致',store.getOrder(1).quantity===12.5);
  await page.locator('[data-nav="工序时间库"]').click();check('预留模块明确展示待需求补齐',(await page.locator('#content').innerText()).includes('待需求补齐'));await page.locator('[data-nav="机加总表"]').first().click();await page.locator('[data-action=collapse]').click();check('左侧导航可收缩',await page.locator('.shell.collapsed').count()===1);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve('test-results/mobile.png'),fullPage:true});check('手机宽度没有页面整体横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  check('浏览器无未处理 JavaScript 错误',errors.length===0);
  mkdirSync('test-results',{recursive:true});writeFileSync('test-results/e2e-results.json',JSON.stringify({at:new Date().toISOString(),results,errors},null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}

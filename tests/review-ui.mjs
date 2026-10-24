import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createApp} from '../src/server.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'machining-review-ui-'));
  const app=createApp({dataDir:dir});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage();const errors=[];page.on('pageerror',err=>errors.push(err.message));
  t.after(async()=>{await browser.close();await new Promise(r=>app.server.close(r));app.store.close();rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  app.s7.status=()=>({connected:true});app.s7.lookup=async code=>({material:{code,name:'物料 '+code},bom:[],bomStatus:'missing'});
  await page.goto('http://127.0.0.1:'+app.server.address().port);await page.waitForSelector('#orders-table');
  return {...app,page};
}
const candidate=code=>({productionId:'H-'+code,productionRowId:'R-'+code,productionNo:'ERP-'+code,productCode:code,quantity:3,approved:true});
const openForm=async page=>{await page.locator('[data-action=new]').first().click();return page.locator('#order-form');};

test('切换成品后旧生产候选立即失效，不能重新选择旧编码生产行',async t=>{
  const {page,s7}=await fixture(t);s7.candidates=async code=>[candidate(code)];
  const form=await openForm(page);await form.locator('[name=productCode]').fill('P1');await page.locator('#query-production').click();await page.waitForFunction(()=>document.querySelector('#production-select').options.length===2);
  await form.locator('[name=productCode]').fill('P2');
  assert.equal(await page.locator('#production-select option').count(),1);
  assert.equal(await form.locator('[name=productionId]').inputValue(),'');
});
test('旧编码慢查询返回后不回填生产候选',async t=>{
  const {page,s7}=await fixture(t);const gate=deferred(),started=deferred();s7.candidates=async code=>{started.resolve();await gate.promise;return [candidate(code)];};
  const form=await openForm(page);await form.locator('[name=productCode]').fill('P1');await page.locator('#query-production').click();await started.promise;
  await form.locator('[name=productCode]').fill('P2');const response=page.waitForResponse(r=>r.url().endsWith('/api/s7/production-candidates'));gate.resolve();await response;await page.waitForFunction(()=>!document.querySelector('#query-production').disabled);
  assert.equal(await page.locator('#production-select option').count(),1);
});
test('关闭旧表单后的查询错误不污染重新打开的表单',async t=>{
  const {page}=await fixture(t);const gate=deferred(),started=deferred();
  await page.route('**/api/materials/P1',async route=>{started.resolve();await gate.promise;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'旧请求故障'})});});
  const form=await openForm(page);await form.locator('[name=productCode]').fill('P1');await page.locator('#lookup-material').click();await started.promise;
  await page.locator('.close-modal').click();await openForm(page);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/materials/P1'));gate.resolve();await response;await page.waitForTimeout(100);
  assert.ok(!(await page.locator('#lookup-message').innerText()).includes('旧请求故障'));
});
test('查询等待期间人工修改物料名称，不被迟到的查询覆盖',async t=>{
  const {page,s7}=await fixture(t);const gate=deferred(),started=deferred();s7.lookup=async code=>{started.resolve();await gate.promise;return {material:{code,name:'ERP 名称'},bom:[],bomStatus:'missing'};};
  const form=await openForm(page);await form.locator('[name=productCode]').fill('P1');await page.locator('#lookup-material').click();await started.promise;
  await form.locator('[name=productName]').fill('等待期间人工备注名称');const response=page.waitForResponse(r=>r.url().endsWith('/api/materials/P1'));gate.resolve();await response;await page.waitForFunction(()=>!document.querySelector('#lookup-material').disabled);
  assert.equal(await form.locator('[name=productName]').inputValue(),'等待期间人工备注名称');
});
test('切换生产行时跟随自动带出的批次，保留人工输入批次',async t=>{
  const {page,s7}=await fixture(t);s7.candidates=async code=>[{...candidate(code),batch:'B1'},{...candidate(code),productionId:'H2',productionRowId:'R2',productionNo:'ERP2',batch:'B2'}];
  const form=await openForm(page);await form.locator('[name=productCode]').fill('P1');await page.locator('#query-production').click();await page.waitForFunction(()=>document.querySelector('#production-select').options.length===3);
  await page.locator('#production-select').selectOption('H-P1|R-P1');assert.equal(await form.locator('[name=batch]').inputValue(),'B1');
  await page.locator('#production-select').selectOption('H2|R2');assert.equal(await form.locator('[name=batch]').inputValue(),'B2');
  await form.locator('[name=batch]').fill('MANUAL');await page.locator('#production-select').selectOption('H-P1|R-P1');assert.equal(await form.locator('[name=batch]').inputValue(),'MANUAL');
});
test('已绑定生产行不在重新查询结果中时，不保留不可见的旧绑定',async t=>{
  const {page,s7,store}=await fixture(t);s7.candidates=async()=>[];
  store.createOrder({productCode:'P1',productName:'成品',quantity:1,requester:'备料',productionId:'GONE',productionRowId:'GONE-ROW',productionNo:'已失效生产单'});
  await page.reload();await page.waitForSelector('[data-detail]');await page.locator('[data-detail]').click();await page.locator('#edit-order').click();
  await page.locator('#query-production').click();await page.waitForFunction(()=>!document.querySelector('#query-production').disabled);
  assert.equal(await page.locator('#order-form [name=productionId]').inputValue(),'');
});

'use strict';
const fs=require('node:fs'),path=require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.tools/ms-playwright');
const {chromium}=require('@playwright/test');
(async()=>{
 const base=process.env.BASE_URL||'http://127.0.0.1:3000',out=path.resolve('docs/screenshots/session-states');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch();
 for(const [name,width,height] of [['desktop',1900,1000],['mobile',390,844]]){
  const ctx=await browser.newContext({viewport:{width,height}}),page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/',{waitUntil:'networkidle'});await page.screenshot({path:path.join(out,name+'-visitor-top.png')});
  await page.locator('[data-cookie-choice=reject]').first().click();await page.screenshot({path:path.join(out,name+'-visitor-full.png'),fullPage:true});await page.locator('.home-memberships').screenshot({path:path.join(out,name+'-visitor-memberships.png')});
  console.log(name,'visitor',await page.evaluate(()=>({state:document.body.dataset.sessionState,membership:!!document.querySelector('.home-memberships'),overflow:document.documentElement.scrollWidth>innerWidth})));
  await page.goto(base+'/login');await page.fill('#email','basic@copart.test');await page.fill('#pw',process.env.DEMO_PASSWORD||'Demo2026!');await Promise.all([page.waitForURL(u=>!u.pathname.startsWith('/login')),page.click('main button[type=submit]')]);
  await page.goto(base+'/',{waitUntil:'networkidle'});await page.screenshot({path:path.join(out,name+'-member-top.png')});await page.screenshot({path:path.join(out,name+'-member-full.png'),fullPage:true});
  console.log(name,'member',await page.evaluate(()=>({state:document.body.dataset.sessionState,membership:!!document.querySelector('.home-memberships'),overflow:document.documentElement.scrollWidth>innerWidth})));
  await page.locator('.home-popular .lot-num').first().click();await page.waitForLoadState('networkidle');await page.screenshot({path:path.join(out,name+'-member-lot.png')});
  if(errors.length)throw Error(errors.join('\n'));await ctx.close();
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

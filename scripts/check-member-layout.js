'use strict';
const path=require('node:path'),fs=require('node:fs');
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.tools/ms-playwright');
const {chromium}=require('@playwright/test');
(async()=>{
  const base=process.env.BASE_URL||'http://127.0.0.1:3000';
  const out=path.resolve('docs/screenshots/member-density');fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch();
  const ctx=await browser.newContext({viewport:{width:1900,height:1000}});const page=await ctx.newPage();
  const failures=[];page.on('pageerror',e=>failures.push(e.message));
  await page.goto(base+'/login');await page.fill('#email','guest@copart.test');await page.fill('#pw',process.env.DEMO_PASSWORD||'Demo2026!');
  await Promise.all([page.waitForURL('**/dashboard'),page.click('main button[type=submit]')]);
  for(const route of ['/dashboard/lots','/dashboard/bids','/dashboard/bids?tab=won','/dashboard/payments?tab=history','/dashboard','/vehicle-finder']){
    const res=await page.goto(base+route,{waitUntil:'networkidle'});if(res.status()!==200)throw Error(route+': '+res.status());
    await page.screenshot({path:path.join(out,route.replace(/[^a-z0-9]/gi,'_')+'.png')});
    console.log(route,await page.evaluate(()=>({header:document.querySelector('.hdr-main').getBoundingClientRect().height,nav:document.querySelector('.hdr-nav').getBoundingClientRect().height,footer:Math.round(document.querySelector('.site-footer').getBoundingClientRect().top),overflow:document.documentElement.scrollWidth>innerWidth})));
  }
  await page.goto(base+'/vehicles');await page.locator('a[href^="/lot/"]').first().click();
  await page.screenshot({path:path.join(out,'lot.png'),fullPage:true});
  await ctx.close();
  const scaled=await browser.newContext({viewport:{width:1520,height:800},deviceScaleFactor:1.25});
  const p=await scaled.newPage();await p.goto(base+'/login');await p.fill('#email','guest@copart.test');await p.fill('#pw',process.env.DEMO_PASSWORD||'Demo2026!');await Promise.all([p.waitForURL('**/dashboard'),p.click('main button[type=submit]')]);
  await p.goto(base+'/dashboard/lots',{waitUntil:'networkidle'});await p.screenshot({path:path.join(out,'lots-125-percent.png')});
  await browser.close();if(failures.length)throw Error(failures.join('\n'));
})().catch(e=>{console.error(e);process.exit(1)});

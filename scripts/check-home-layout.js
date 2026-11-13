'use strict';
const fs=require('node:fs'),path=require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.tools/ms-playwright');
const {chromium}=require('@playwright/test');
(async()=>{
 const base=process.env.BASE_URL||'http://127.0.0.1:3000',out=path.resolve('docs/screenshots/home-reference');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch();
 for(const [name,width,height] of [['desktop',1900,1000],['mobile',390,844]]){
  const ctx=await browser.newContext({viewport:{width,height}}),page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const response=await page.goto(base+'/',{waitUntil:'networkidle'});if(response.status()!==200)throw Error('Portada '+response.status());
  await page.screenshot({path:path.join(out,name+'-home.png'),fullPage:true});
  await page.getByRole('button',{name:'Banner siguiente'}).click();await page.screenshot({path:path.join(out,name+'-wholesale.png')});
  await page.locator('.home-popular .lot-num').first().click();await page.waitForLoadState('networkidle');
  await page.screenshot({path:path.join(out,name+'-public-lot.png'),fullPage:true});
  console.log(name,{errors,lotStatus:await page.locator('main h1').textContent(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
  if(errors.length)throw Error(errors.join('\n'));await ctx.close();
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

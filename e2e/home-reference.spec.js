const {test,expect}=require('@playwright/test');

test('portada: banner, cuatro tarjetas, pestañas y navegación real',async({page})=>{
  await page.setViewportSize({width:1900,height:1000});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  expect((await page.goto('/')).status()).toBe(200);
  await expect(page.getByRole('heading',{name:'Subastas de Autos 100% En línea'})).toBeVisible();
  await expect(page.locator('[data-hero-slide]').nth(1)).toBeHidden();await page.getByRole('button',{name:'Banner siguiente'}).click();
  await expect(page.locator('[data-hero-slide]').nth(1)).toBeVisible();await page.getByRole('button',{name:'Banner anterior'}).click();
  await expect(page.locator('[data-hero-slide]').first()).toBeVisible();
  expect(await page.locator('.home-popular .lot-card').count()).toBeGreaterThanOrEqual(4);
  const geometry=await page.evaluate(()=>{const cards=Array.from(document.querySelectorAll('.home-popular .lot-card'));return {hero:document.querySelector('.home-hero').getBoundingClientRect().height,width:cards[0].getBoundingClientRect().width,fourth:cards[3].getBoundingClientRect().right,overflow:document.documentElement.scrollWidth>innerWidth};});
  expect(geometry.hero).toBeLessThanOrEqual(401);expect(geometry.width).toBeGreaterThan(350);expect(geometry.fourth).toBeLessThan(1901);expect(geometry.overflow).toBe(false);
  for(const id of ['home-models','home-featured','home-types','home-regions','home-cities','home-trending','home-makes']){await page.locator('[data-tab="'+id+'"]').click();await expect(page.locator('#'+id)).toBeVisible();}
  await page.locator('.home-popular .lot-card a.lot-num').first().click();await expect(page.locator('main h1')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/buyer-portal/);await expect(page.locator('.hdr-main')).toBeHidden();
  const width=await page.locator('.reference-lot').evaluate(e=>e.getBoundingClientRect().width);expect(width).toBeLessThanOrEqual(1605);expect(width).toBeGreaterThan(1500);
  await expect(page.getByRole('link',{name:'Iniciar sesión para ofertar'})).toBeVisible();expect(await page.locator('.gallery-main img').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
  expect(errors).toEqual([]);
});

test('portada y ficha pública en móvil sin desbordamiento',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.locator('.home-popular .lot-card a.lot-num').first().click();await expect(page.locator('main h1')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

(function(){
  'use strict';
  var hero=document.querySelector('[data-hero-carousel]');if(!hero)return;
  var slides=Array.from(hero.querySelectorAll('[data-hero-slide]')),current=0;
  function show(index){current=(index+slides.length)%slides.length;slides.forEach(function(slide,i){slide.hidden=i!==current;slide.setAttribute('aria-hidden',String(i!==current));});}
  hero.querySelector('[data-hero-next]').addEventListener('click',function(){show(current+1);});
  hero.querySelector('[data-hero-prev]').addEventListener('click',function(){show(current-1);});
  hero.addEventListener('keydown',function(e){if(e.key==='ArrowRight'){e.preventDefault();show(current+1);}if(e.key==='ArrowLeft'){e.preventDefault();show(current-1);}});
})();

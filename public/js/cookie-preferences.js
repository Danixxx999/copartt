(function(){
 'use strict';
 var banner=document.querySelector('[data-cookie-banner]'),dialog=document.querySelector('[data-cookie-dialog]');if(!banner)return;
 function save(analytics,marketing){var value=encodeURIComponent(JSON.stringify({essential:true,analytics:analytics,marketing:marketing,version:1}));document.cookie='ap_cookie_preferences='+value+'; Path=/; Max-Age=31536000; SameSite=Lax';banner.hidden=true;if(dialog&&dialog.open)dialog.close();}
 try{var saved=document.cookie.split('; ').find(function(c){return c.startsWith('ap_cookie_preferences=');});if(saved&&dialog){var prefs=JSON.parse(decodeURIComponent(saved.slice(saved.indexOf('=')+1)));dialog.querySelector('[name=analytics]').checked=!!prefs.analytics;dialog.querySelector('[name=marketing]').checked=!!prefs.marketing;}}catch(e){}
 banner.addEventListener('click',function(e){var choice=e.target.closest('[data-cookie-choice]');if(choice){save(choice.dataset.cookieChoice==='accept',choice.dataset.cookieChoice==='accept');}});
 document.addEventListener('click',function(e){if(e.target.closest('[data-cookie-settings]')&&dialog)dialog.showModal();});
 if(dialog)dialog.querySelector('form').addEventListener('submit',function(e){e.preventDefault();var data=new FormData(e.target);save(data.has('analytics'),data.has('marketing'));});
})();

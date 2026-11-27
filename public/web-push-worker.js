// No offline cache: private pages and conversations always use the server.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let data;try{data=event.data?.json();}catch{return;}
    if(data?.kind!=='chat' || !/^[a-f0-9-]{36}$/.test(data.device||'') || !Number.isSafeInteger(data.message) || data.message<1)return;
    try {
      // Recheck after delivery too: signing out, switching accounts, reading,
      // blocking or deleting while a notification is in transit invalidates it.
      const response=await fetch('/api/push/web/check?device='+encodeURIComponent(data.device)+'&message='+data.message,
        {credentials:'include',cache:'no-store'});
      if(!response.ok || !(await response.json()).notify)return;
      await self.registration.showNotification('종이편지',{
        body:'새 대화 또는 답장이 도착했어요.',icon:'/icon.svg',tag:'paperchat-chat',renotify:true,
        data:{url:'/?inbox=1'}
      });
    }catch{/* An unverified account must never receive another account's alert. */}
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const target=windows.find(client=>{
      const url=new URL(client.url);
      return url.origin===self.location.origin && ['/', '/app'].includes(url.pathname);
    });
    if(target){await target.navigate(new URL(target.url).pathname+'?inbox=1');await target.focus();}
    else await self.clients.openWindow('/?inbox=1');
  })());
});

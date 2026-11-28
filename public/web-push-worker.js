// No offline cache: private pages and conversations always use the server.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
const validPost=id=>Number.isSafeInteger(id)&&id>0;
const validIdentifier=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let data;try{data=event.data?.json();}catch{return;}
    const news=data?.kind==='news';
    if(!validIdentifier(data?.device)||(!news&&data?.kind!=='chat'))return;
    if(news?(!validIdentifier(data.event)||!validPost(data.postId)||!['like','comment'].includes(data.newsType)):
      (!Number.isSafeInteger(data.message)||data.message<1))return;
    try {
      // Recheck after delivery too: signing out, switching accounts, reading,
      // blocking or deleting while a notification is in transit invalidates it.
      const check='/api/push/web/check?device='+encodeURIComponent(data.device)+(news?
        '&kind=news&postId='+data.postId+'&event='+encodeURIComponent(data.event):'&message='+data.message);
      const response=await fetch(check,
        {credentials:'include',cache:'no-store'});
      if(!response.ok)return;
      const verified=await response.json();if(!verified.notify)return;
      if(news&&(!validPost(verified.postId)||verified.postId!==data.postId||!['like','comment'].includes(verified.newsType)))return;
      await self.registration.showNotification('종이편지',{
        body:news?(verified.newsType==='like'?'회원님의 소식에 좋아요가 달렸어요.':'회원님의 소식에 새 댓글이 달렸어요.'):'새 대화 또는 답장이 도착했어요.',
        icon:'/icon.svg',tag:news?'paperchat-news-'+verified.postId:'paperchat-chat',renotify:true,
        data:news?{kind:'news',postId:verified.postId,url:'/?news='+verified.postId}:{url:'/?inbox=1'}
      });
    }catch{/* An unverified account must never receive another account's alert. */}
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const data=event.notification.data,query=data?.kind==='news'&&validPost(data.postId)?'?news='+data.postId:'?inbox=1';
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const target=windows.find(client=>{
      const url=new URL(client.url);
      return url.origin===self.location.origin && ['/', '/app'].includes(url.pathname);
    });
    if(target){await target.navigate(new URL(target.url).pathname+query);await target.focus();}
    else await self.clients.openWindow('/'+query);
  })());
});

import type { StationAdmissionEvent } from './station-client';
import './coin-insertion.css';

export interface CoinInsertionPresenter {show(event:StationAdmissionEvent):void;}

export function createCoinInsertionPresenter(host:HTMLElement=document.body):CoinInsertionPresenter{
  const root=document.createElement('div');root.className='coin-insertion-layer';root.setAttribute('role','status');root.setAttribute('aria-live','polite');root.setAttribute('aria-atomic','true');
  host.append(root);
  const queue:StationAdmissionEvent[]=[];
  const seen=new Set<number>();
  let active=false;
  const drain=()=>{
    if(active||!queue.length)return;
    active=true;
    const event=queue.shift()!;
    const cue=document.createElement('div');cue.className=`coin-insertion-cue ${event.admission}`;
    const cabinet=document.createElement('div');cabinet.className='coin-cabinet';cabinet.setAttribute('aria-hidden','true');
    const coin=document.createElement('span');coin.className='arcade-coin';coin.textContent=event.admission==='coin'?'1':'✓';
    const slot=document.createElement('span');slot.className='coin-slot';cabinet.append(coin,slot);
    const copy=document.createElement('div');copy.className='coin-insertion-copy';
    const label=document.createElement('span');label.textContent=event.admission==='coin'?'COIN ACCEPTED':'READY CONFIRMED';
    const name=document.createElement('strong');name.textContent=`${event.displayName} · READY`;
    copy.append(label,name);cue.append(cabinet,copy);root.replaceChildren(cue);
    root.setAttribute('aria-label',`${label.textContent}. ${event.displayName} is ready.`);
    window.setTimeout(()=>{cue.classList.add('leaving');window.setTimeout(()=>{
      cue.remove();root.removeAttribute('aria-label');active=false;
      if(document.visibilityState==='hidden')queue.length=0;
      drain();
    },220);},1800);
  };
  return{show(event){
    if(document.visibilityState==='hidden'||seen.has(event.revision))return;
    seen.add(event.revision);
    if(seen.size>256)seen.delete(seen.values().next().value!);
    if(queue.length>=8)queue.shift();
    queue.push(event);drain();
  }};
}

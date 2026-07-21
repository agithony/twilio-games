import QRCode from 'qrcode';

type ArcadeMode = 'off' | 'coin_only' | 'lead_capture';
type QueueStatus = 'WAITING' | 'APPROACHING' | 'CALLED' | 'CHECKED_IN' | 'ACTIVE_LOBBY' | 'PLAYING' | 'COMPLETED' | 'DEFERRED' | 'NO_SHOW' | 'LEFT_QUEUE' | 'RELEASED';
type Game = 'racer' | 'monsters' | 'fighter' | 'trivia';

interface PublicConfig { version:number; arcade:{mode:ArcadeMode;cabinetId:string}; earning:{enabled:boolean}; }
interface PlayerStatus { registered:boolean; firstName:string|null; preferredLocale:string|null; }
interface WalletStatus { ledgerBalance:number; reservedBalance:number; availableBalance:number; updatedAt:string; }
interface QueueView { status:QueueStatus;preferredGame:Game;flexibleGame:boolean;position:number|null;joinedAt:string;approachingConfirmedAt:string|null;calledAt:string|null;checkInExpiresAt:string|null;deferredUntil:string|null;checkedInAt:string|null;reservation:{amount:number;status:string}|null; }
interface Challenge { id:string;title:string;rewardCoins:number;displayOrder:number;claimCount:number;maxClaimsPerPlayer:number;available:boolean;startsAt:string|null;endsAt:string|null; }
interface OperatorEntry extends QueueView { queueEntryId:string;firstName:string|null;assignedGame:Game|null;matchId:string|null; }
interface AdminConfig extends Record<string,unknown> { version:number;updatedAt:string;updatedBy:string;schemaVersion:number;arcade:{mode:ArcadeMode;cabinetId:string};coins:{startingBalance:number};earning:{enabled:boolean;challenges:Array<Record<string,unknown>>}; }

class ApiError extends Error { constructor(readonly status:number,readonly code:string,message:string){super(message);} }

const state: {
  config: PublicConfig | null;
  player: PlayerStatus | null;
  wallet: WalletStatus | null;
  queue: QueueView | null;
  adminConfig: AdminConfig | null;
  adminEmail: string | null;
  operatorQueue: OperatorEntry[];
} = { config:null,player:null,wallet:null,queue:null,adminConfig:null,adminEmail:null,operatorQueue:[] };

const notice = el('notice'), modeBadge = el('mode-badge'), heroBalance = el('hero-balance');
const operatorView = new URLSearchParams(location.search).get('operator') === '1';
el('refresh').addEventListener('click', () => void refreshAll());
el('theme-toggle').addEventListener('click', toggleTheme);
el<HTMLFormElement>('registration-form').addEventListener('submit', event => void register(event));
el<HTMLFormElement>('join-form').addEventListener('submit', event => void joinQueue(event));
el('queue-confirm').addEventListener('click', () => void queueAction('/api/arcade/queue/confirm', {}));
el('queue-snooze').addEventListener('click', () => void queueAction('/api/arcade/queue/snooze', {}));
el('queue-leave').addEventListener('click', () => void queueAction('/api/arcade/queue/leave', {}));
el('queue-check-in').addEventListener('click', () => void checkIn());
el<HTMLFormElement>('mode-form').addEventListener('submit', event => void saveMode(event));
el('seed-challenge').addEventListener('click', () => void seedChallenge());
el('operator-refresh').addEventListener('click', () => void refreshOperator());
el('admin-logout').addEventListener('click', () => void switchAccount());
el('start-selected').addEventListener('click', () => void startSelectedMatches());
el('complete-selected').addEventListener('click', () => void completeSelectedMatch());
applyTheme();
configureView();
void refreshAll();

async function refreshAll(): Promise<void> {
  setNotice('Refreshing Arcade state...');
  try {
    state.config = await api<PublicConfig>('/api/arcade/config/public');
    renderMode();
    await renderPlayerQr();
    if(operatorView){await checkAdmin();show('operations',true);show('dashboard',false);if(state.adminConfig)await refreshOperator();setNotice(state.config.arcade.mode==='off'?'Arcade is off. Choose a mode below to begin accepting players.':'Operator console is ready.');return;}
    show('operations',false);show('dashboard',true);
    if (state.config.arcade.mode === 'off') {
      state.player = null; state.wallet = null; state.queue = null;
      renderPlayer(); setNotice('Arcade is off. Use the operator settings below to enable it.');
      return;
    }
    await ensureSession();
    await refreshPlayer();
    setNotice('Arcade state is current.', 'success');
  } catch (error) { showError(error); }
}

function configureView():void{
  const link=el<HTMLAnchorElement>('view-link');
  if(operatorView){link.href='/arcade/';link.textContent='Player view';el('hero-title').innerHTML='Run the cabinet. <span>Players scan.</span>';el('hero-lede').textContent='Display the persistent QR and record queue, reservation, and match-ledger transitions. Game servers do not consume these match controls yet.';show('balance-hero',false);show('off-panel',false);}
  else{link.href='/arcade/?operator=1';link.textContent='Operator view';}
}

async function renderPlayerQr():Promise<void>{
  if(!state.config)return;const url=new URL('/arcade/',location.origin);url.searchParams.set('cabinet',state.config.arcade.cabinetId);const value=url.toString();el('player-url').textContent=value;
  try{el<HTMLImageElement>('player-qr').src=await QRCode.toDataURL(value,{width:520,margin:1,color:{dark:'#000D25',light:'#FFFFFF'},errorCorrectionLevel:'M'});}catch{el<HTMLImageElement>('player-qr').removeAttribute('src');}
}

async function ensureSession(): Promise<void> {
  if(!state.config)return;const scannedCabinet=new URLSearchParams(location.search).get('cabinet');
  await post('/api/arcade/session', { cabinetId: scannedCabinet??state.config.arcade.cabinetId });
}

async function refreshPlayer(): Promise<void> {
  state.player = await api<PlayerStatus>('/api/arcade/player');
  state.wallet = await maybe<WalletStatus>('/api/arcade/wallet');
  const queueResponse = await maybe<{queue:QueueView|null}>('/api/arcade/queue/status');
  state.queue = queueResponse?.queue ?? null;
  renderPlayer();
  if (state.player.registered || state.config?.arcade.mode === 'coin_only') await refreshChallenges();
}

function renderMode(): void {
  const mode = state.config?.arcade.mode ?? 'off';
  modeBadge.textContent = mode.replace('_',' ');
  modeBadge.className = `badge ${mode === 'off' ? 'off' : 'active'}`;
  show('off-panel', mode === 'off');
}

function renderPlayer(): void {
  const mode = state.config?.arcade.mode ?? 'off';
  const ready = Boolean(state.player?.registered || mode === 'coin_only');
  show('registration-panel', mode === 'lead_capture' && !state.player?.registered);
  show('player-panel', ready);
  show('wallet-panel', ready && Boolean(state.wallet));
  show('challenge-panel', ready);
  show('queue-panel', ready);
  el('player-greeting').textContent = state.player?.firstName ? `${state.player.firstName}, you are ready.` : 'Coin player ready.';
  const wallet = state.wallet;
  heroBalance.textContent = wallet ? String(wallet.availableBalance) : '--';
  el('ledger-balance').textContent = wallet ? String(wallet.ledgerBalance) : '--';
  el('reserved-balance').textContent = wallet ? String(wallet.reservedBalance) : '--';
  el('available-balance').textContent = wallet ? String(wallet.availableBalance) : '--';
  renderQueue();
}

async function register(event: Event): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement, data = new FormData(form);
  setBusy(form,true); setNotice('Creating player and granting the starting coin...');
  try {
    await post('/api/arcade/register', {
      lead: {
        firstName:text(data,'firstName'), lastName:text(data,'lastName'), workEmail:text(data,'workEmail'),
        companyName:text(data,'companyName'), phoneNumber:text(data,'phoneNumber'), countryCode:text(data,'countryCode').toUpperCase(),
      },
      termsAccepted:data.get('termsAccepted') === 'on', marketingConsent:data.get('marketingConsent') === 'on',
    });
    await refreshPlayer(); setNotice('Registration complete. Your starting coin is ready.', 'success');
  } catch(error){showError(error);} finally{setBusy(form,false);}
}

async function refreshChallenges(): Promise<void> {
  const host = el('challenges');
  try {
    const result = await api<{challenges:Challenge[]}>('/api/arcade/challenges');
    host.replaceChildren();
    if (!result.challenges.length) { host.innerHTML = '<div class="empty">No active challenges yet.</div>'; return; }
    for (const challenge of result.challenges) {
      const item = document.createElement('div'); item.className = 'list-item';
      const copy = document.createElement('div');
      const title = document.createElement('h4'); title.textContent = challenge.title;
      const detail = document.createElement('p'); detail.textContent = `Earn ${challenge.rewardCoins} coin${challenge.rewardCoins === 1 ? '' : 's'} · ${challenge.claimCount}/${challenge.maxClaimsPerPlayer} claimed`;
      copy.append(title,detail);
      const button = document.createElement('button'); button.className='button primary'; button.type='button';
      button.textContent = challenge.available ? `Earn +${challenge.rewardCoins}` : 'Claimed'; button.disabled=!challenge.available;
      button.addEventListener('click',()=>void claimChallenge(challenge,button));
      item.append(copy,button); host.append(item);
    }
  } catch(error){host.innerHTML='<div class="empty">Challenges unavailable.</div>';showError(error);}
}

async function claimChallenge(challenge:Challenge,button:HTMLButtonElement):Promise<void>{
  button.disabled=true; setNotice(`Claiming ${challenge.title}...`);
  const destination=window.open('about:blank','_blank');if(destination)destination.opener=null;
  try{
    const issued=await post<{token:string}>(`/api/arcade/challenges/${challenge.id}/token`,{});
    const result=await post<{destinationUrl:string;availableBalance:number}>(`/api/arcade/challenges/${challenge.id}/claim`,{token:issued.token});
    setNotice(`Coin earned. Opening ${challenge.title}.`,'success');
    if(destination)destination.location.href=result.destinationUrl;else location.href=result.destinationUrl;await refreshPlayer();
  }catch(error){destination?.close();showError(error);button.disabled=false;}
}

async function joinQueue(event:Event):Promise<void>{
  event.preventDefault(); const form=event.currentTarget as HTMLFormElement,data=new FormData(form); setBusy(form,true);
  try{await post('/api/arcade/queue/join',{preferredGame:text(data,'preferredGame'),flexibleGame:data.get('flexibleGame')==='on'});await refreshPlayer();setNotice('You joined the cabinet queue.','success');}
  catch(error){showError(error);}finally{setBusy(form,false);}
}

async function queueAction(path:string,body:unknown):Promise<void>{
  try{await post(path,body);await refreshPlayer();setNotice('Queue updated.','success');}catch(error){showError(error);}
}

async function checkIn():Promise<void>{
  const queue=state.queue;if(!queue)return;let game:Game=queue.preferredGame;
  if(queue.flexibleGame){const selected=prompt('Game at this cabinet: racer, monsters, fighter, or trivia',queue.preferredGame)?.trim();if(!selected)return;if(!['racer','monsters','fighter','trivia'].includes(selected)){setNotice('Choose racer, monsters, fighter, or trivia.','error');return;}game=selected as Game;}
  await queueAction('/api/arcade/check-in',{game});
}

function renderQueue():void{
  const form=el<HTMLFormElement>('join-form'),box=el('queue-status'),actions=el('queue-actions'),queue=state.queue;
  form.hidden=Boolean(queue); box.hidden=!queue; actions.hidden=!queue;
  if(!queue)return;
  box.innerHTML=`<strong>${escapeHtml(queue.status.replace('_',' '))}</strong><dl><div><dt>Position</dt><dd>${queue.position ?? escapeHtml(queue.status.replace('_',' '))}</dd></div><div><dt>Game</dt><dd>${gameName(queue.preferredGame)}</dd></div><div><dt>Coin</dt><dd>${queue.reservation ? `${queue.reservation.status} (${queue.reservation.amount})` : 'Not reserved'}</dd></div></dl>`;
  toggleButton('queue-confirm',queue.status==='APPROACHING');toggleButton('queue-check-in',queue.status==='CALLED');
  toggleButton('queue-snooze',['WAITING','APPROACHING','CALLED'].includes(queue.status));toggleButton('queue-leave',['WAITING','APPROACHING','CALLED','DEFERRED'].includes(queue.status));
}

async function checkAdmin():Promise<void>{
  const session=await maybe<{authenticated:boolean;email?:string}>('/api/analytics/session'); state.adminEmail=session?.authenticated?session.email??null:null;
  state.adminConfig=null;
  try{state.adminConfig=await api<AdminConfig>('/api/admin/arcade/config');if(!state.adminEmail&&state.adminConfig)state.adminEmail='Local development admin';}catch{/* Not Arcade-authorized. */}
  const authorized=Boolean(state.adminConfig); show('admin-console',authorized);show('admin-locked',!authorized);show('admin-login',!authorized);show('admin-user',Boolean(state.adminEmail));show('admin-logout',Boolean(state.adminEmail&&state.adminEmail!=='Local development admin'));
  el<HTMLAnchorElement>('admin-login').textContent=state.adminEmail?'Use another Google account':'Sign in with Google';
  el('admin-user').textContent=authorized?`Signed in as ${state.adminEmail}`:`${state.adminEmail??''} is not an Arcade admin`;
  if(state.adminConfig){el<HTMLSelectElement>('admin-mode').value=state.adminConfig.arcade.mode;el<HTMLInputElement>('admin-starting-coins').value=String(state.adminConfig.coins.startingBalance);}
}

async function switchAccount():Promise<void>{await fetch('/auth/logout',{method:'POST',credentials:'include'});location.href='/auth/google?returnTo=/arcade/%3Foperator%3D1';}

async function saveMode(event:Event):Promise<void>{
  event.preventDefault();if(!state.adminConfig)return;
  const config=state.adminConfig,{schemaVersion:_s,version,updatedAt:_a,updatedBy:_b,...settings}=config;
  (settings.arcade as AdminConfig['arcade']).mode=el<HTMLSelectElement>('admin-mode').value as ArcadeMode;
  (settings.coins as AdminConfig['coins']).startingBalance=Number(el<HTMLInputElement>('admin-starting-coins').value);
  try{await updateConfig(version,settings);setNotice('Runtime settings saved.','success');await refreshAll();}catch(error){showError(error);}
}

async function seedChallenge():Promise<void>{
  if(!state.adminConfig)return;const config=state.adminConfig,{schemaVersion:_s,version,updatedAt:_a,updatedBy:_b,...settings}=config;
  const earning=settings.earning as AdminConfig['earning'];earning.enabled=true;
  if(!earning.challenges.some(item=>item.id==='voice-docs'))earning.challenges.push({id:'voice-docs',title:'Explore the Twilio Voice docs',url:'https://www.twilio.com/docs/voice',rewardCoins:1,enabled:true,maxClaimsPerPlayer:1,displayOrder:0,startsAt:null,endsAt:null});
  try{await updateConfig(version,settings);setNotice('Voice docs challenge added.','success');await refreshAll();}catch(error){showError(error);}
}

async function updateConfig(version:number,settings:Record<string,unknown>):Promise<void>{
  await api('/api/admin/arcade/config',{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':`"arcade-config-${version}"`,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(settings)});
}

async function refreshOperator():Promise<void>{
  if(!state.adminConfig)return;const host=el('operator-queue');
  try{const result=await api<{queue:OperatorEntry[]}>('/api/admin/arcade/queue');state.operatorQueue=result.queue;host.replaceChildren();if(!result.queue.length){host.innerHTML='<div class="empty">No players are waiting.</div>';updateSelectionActions();return;}for(const entry of result.queue)host.append(operatorItem(entry));updateSelectionActions();}
  catch(error){host.innerHTML='<div class="empty">Operator queue unavailable.</div>';showError(error);}
}

function operatorItem(entry:OperatorEntry):HTMLElement{
  const item=document.createElement('div');item.className='list-item';const copy=document.createElement('div');const title=document.createElement('h4');title.textContent=`${entry.firstName??'Coin player'} · ${entry.status.replace('_',' ')}`;
  if(['ACTIVE_LOBBY','PLAYING'].includes(entry.status)){const select=document.createElement('label');select.className='operator-select';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.queueEntryId=entry.queueEntryId;const playerName=entry.firstName??'coin player';checkbox.setAttribute('aria-label',`Select ${playerName} ${entry.queueEntryId} for match`);checkbox.addEventListener('change',updateSelectionActions);const text=document.createElement('span');text.textContent=`Select ${playerName} ${entry.queueEntryId.slice(-6)} for match`;select.append(checkbox,text);copy.append(select);}
  const meta=document.createElement('div');meta.className='meta';meta.textContent=`${gameName(entry.assignedGame??entry.preferredGame)} · ${entry.position===null?entry.status:`position ${entry.position}`} · ${entry.reservation?.status??'no hold'}`;copy.append(title,meta);
  const actions=document.createElement('div');actions.className='operator-actions';
  const add=(label:string,action:()=>Promise<void>)=>{const button=document.createElement('button');button.className='button quiet';button.type='button';button.textContent=label;button.addEventListener('click',()=>void action());actions.append(button);};
  const transition=async(action:string)=>{const reason=prompt(`Reason for ${action}`);if(!reason)return;try{await post(`/api/admin/arcade/queue/${entry.queueEntryId}/${action}`,{reason});await refreshAll();}catch(error){showError(error);}};
  const callReady=entry.status==='APPROACHING'&&Boolean(entry.approachingConfirmedAt);const expireReady=entry.status==='CALLED'&&Boolean(entry.checkInExpiresAt&&Date.parse(entry.checkInExpiresAt)<=Date.now());const requeueReady=entry.status==='DEFERRED'&&Boolean(entry.deferredUntil&&Date.parse(entry.deferredUntil)<=Date.now());
  if(entry.status==='WAITING')add('Approach',()=>transition('approach'));if(callReady)add('Call',()=>transition('call'));if(expireReady)add('Expire',()=>transition('expire'));if(requeueReady)add('Requeue',()=>transition('requeue'));
  if(entry.status==='CHECKED_IN')add('Activate',()=>transition('activate'));if(['CHECKED_IN','ACTIVE_LOBBY'].includes(entry.status))add('Release',()=>transition('release'));
  item.append(copy,actions);return item;
}

function selectedOperatorEntries():OperatorEntry[]{const ids=new Set([...document.querySelectorAll<HTMLInputElement>('.operator-select input:checked')].map(input=>input.dataset.queueEntryId));return state.operatorQueue.filter(entry=>ids.has(entry.queueEntryId));}
function updateSelectionActions():void{const selected=selectedOperatorEntries();const games=new Set(selected.map(entry=>entry.assignedGame??entry.preferredGame));const matches=new Set(selected.map(entry=>entry.matchId));const startReady=selected.length>0&&selected.every(entry=>entry.status==='ACTIVE_LOBBY')&&games.size===1;const completeReady=selected.length>0&&selected.every(entry=>entry.status==='PLAYING'&&Boolean(entry.matchId))&&matches.size===1;const matchSize=completeReady?state.operatorQueue.filter(entry=>entry.matchId===selected[0]?.matchId&&entry.status==='PLAYING').length:0;el<HTMLButtonElement>('start-selected').disabled=!startReady;el<HTMLButtonElement>('complete-selected').disabled=!completeReady;el('selection-count').textContent=completeReady?`${matchSize}-player match selected`:selected.length?`${selected.length} selected`:'Select lobby or playing entries';}
async function startSelectedMatches():Promise<void>{const entries=selectedOperatorEntries();if(!entries.length)return;const game=entries[0]!.assignedGame??entries[0]!.preferredGame;const reason=prompt('Reason for starting selected match');if(!reason)return;try{await post('/api/admin/arcade/matches/start',{queueEntryIds:entries.map(entry=>entry.queueEntryId),game,reason});await refreshAll();}catch(error){showError(error);}}
async function completeSelectedMatch():Promise<void>{const selected=selectedOperatorEntries(),matchId=selected[0]?.matchId;if(!selected.length||!matchId)return;const entries=state.operatorQueue.filter(entry=>entry.matchId===matchId&&entry.status==='PLAYING');const reason=prompt(`Complete all ${entries.length} players in this match`);if(!reason)return;try{await post(`/api/admin/arcade/matches/${matchId}/complete`,{queueEntryIds:entries.map(entry=>entry.queueEntryId),reason});await refreshAll();}catch(error){showError(error);}}

async function post<T=unknown>(path:string,body:unknown):Promise<T>{return api<T>(path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});}
async function api<T=unknown>(path:string,init:RequestInit={}):Promise<T>{const headers=new Headers(init.headers);if(['localhost','127.0.0.1'].includes(location.hostname))headers.set('X-Arcade-Dev-Admin','true');const response=await fetch(path,{credentials:'include',...init,headers});const payload=await response.json().catch(()=>({}));if(!response.ok){const error=(payload as {error?:{code?:string;message?:string}}).error;throw new ApiError(response.status,error?.code??'REQUEST_FAILED',error?.message??`Request failed (${response.status})`);}return payload as T;}
async function maybe<T>(path:string):Promise<T|null>{try{return await api<T>(path);}catch(error){if(error instanceof ApiError&&[401,409].includes(error.status))return null;throw error;}}
function setNotice(message:string,kind:'success'|'error'|''=''):void{notice.textContent=message;notice.className=`notice ${kind}`.trim();}
function showError(error:unknown):void{const message=error instanceof ApiError?`${error.code}: ${error.message}`:error instanceof Error?error.message:String(error);setNotice(message,'error');}
function setBusy(form:HTMLFormElement,busy:boolean):void{for(const control of form.elements)if(control instanceof HTMLButtonElement||control instanceof HTMLInputElement||control instanceof HTMLSelectElement)control.disabled=busy;}
function show(id:string,visible:boolean):void{el(id).hidden=!visible;}function toggleButton(id:string,visible:boolean):void{el<HTMLButtonElement>(id).hidden=!visible;}
function text(data:FormData,key:string):string{return String(data.get(key)??'').trim();}function gameName(game:string):string{return({racer:'Voice Racer',monsters:'Voice Monsters',fighter:'Voice Fighter',trivia:'Voice Trivia'} as Record<string,string>)[game]??game;}
function escapeHtml(value:string):string{const node=document.createElement('span');node.textContent=value;return node.innerHTML;}
function el<T extends HTMLElement=HTMLElement>(id:string):T{return document.getElementById(id) as T;}
function toggleTheme():void{const current=document.documentElement.dataset.theme??'dark';document.documentElement.dataset.theme=current==='dark'?'light':'dark';localStorage.setItem('twilio-theme',document.documentElement.dataset.theme);applyTheme();}
function applyTheme():void{el('theme-toggle').textContent=(document.documentElement.dataset.theme??'dark')==='dark'?'Light mode':'Dark mode';}

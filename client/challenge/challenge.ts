export {};

interface ChallengeCard {
  id:string;
  title:string;
  message:string|null;
  rewardCoins:number;
  action:'visit'|'claim'|'claimed';
}

interface PortalStatus {challenges:ChallengeCard[];availableBalance:number;}

const TOKEN_KEY='twilio-games-challenge-token';
const portuguese=new URLSearchParams(location.search).get('locale')?.toLowerCase().startsWith('pt')===true;
let token='';
try{token=decodeURIComponent(location.hash.slice(1));}catch{/* Invalid link handled below. */}
if(token){try{sessionStorage.setItem(TOKEN_KEY,token);}catch{/* Session storage is optional. */}}
else{try{token=sessionStorage.getItem(TOKEN_KEY)??'';}catch{/* Session storage is optional. */}}
history.replaceState(history.state,'',`${location.pathname}${location.search}`);
const legacyToken=tokenChallenge(token)!=='challenge-portal';

const list=document.getElementById('challenge-list')!;
const statusElement=document.getElementById('status')!;
if(portuguese){
  document.documentElement.lang='pt-BR';
  document.title='Ganhe moedas | Twilio Games';
  document.getElementById('title')!.textContent='Ganhe mais moedas.';
  document.getElementById('description')!.textContent='Abra cada desafio abaixo. Quando voltar, confirme a recompensa. Visite todos para ganhar todas as moedas disponíveis.';
}

async function request<T>(action:'status'|'visit'|'claim',challengeId?:string):Promise<T>{
  const response=await fetch(`/api/arcade/challenge-portal/${action}`,{
    method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token,...(challengeId?{challengeId}:{})}),
  });
  const payload=await response.json().catch(()=>({})) as T&{error?:{message?:unknown}};
  if(!response.ok)throw new Error(typeof payload.error?.message==='string'?payload.error.message:(portuguese?'Não foi possível abrir esta recompensa.':'This reward could not be opened.'));
  return payload;
}

async function refresh():Promise<void>{
  if(!token||token.length>4096){showError(portuguese?'Este link é inválido. Responda MAIS para receber um novo link.':'This link is invalid. Reply MORE for a fresh link.');return;}
  if(legacyToken){renderLegacyClaim();return;}
  statusElement.textContent=portuguese?'Carregando desafios...':'Loading challenges...';
  try{
    const page=await request<PortalStatus>('status');
    render(page);
  }catch(error){showError(error instanceof Error?error.message:(portuguese?'Não foi possível carregar os desafios.':'Challenges could not be loaded.'));}
}

function renderLegacyClaim():void{
  list.replaceChildren();
  const card=document.createElement('article');card.className='challenge-card claim';
  const heading=document.createElement('h2');heading.textContent=portuguese?'Recompensa anterior':'Earlier reward link';
  const message=document.createElement('p');message.textContent=portuguese?'Este link foi enviado antes da atualização. Confirme para resgatar a recompensa.':'This link was sent before the reward hub update. Confirm to claim it.';
  const button=document.createElement('button');button.type='button';button.textContent=portuguese?'Confirmar moedas':'Confirm coins';
  button.addEventListener('click',async()=>{
    button.disabled=true;
    try{
      const response=await fetch('/api/arcade/challenges/redeem',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
      const payload=await response.json() as {destinationUrl?:unknown;error?:{message?:unknown}};
      if(!response.ok||typeof payload.destinationUrl!=='string')throw new Error(typeof payload.error?.message==='string'?payload.error.message:'Reward failed.');
      location.href=payload.destinationUrl;
    }catch(error){statusElement.textContent=error instanceof Error?error.message:'Reward failed.';button.disabled=false;}
  });
  card.append(heading,message,button);list.append(card);statusElement.textContent='';
}

function tokenChallenge(value:string):string|null{
  try{
    const part=value.split('.')[0]??'';
    const base64=part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'=');
    const bytes=Uint8Array.from(atob(base64),character=>character.charCodeAt(0));
    const payload=JSON.parse(new TextDecoder().decode(bytes)) as {challenge?:unknown};
    return typeof payload.challenge==='string'?payload.challenge:null;
  }catch{return null;}
}

function render(page:PortalStatus):void{
  list.replaceChildren();
  if(!page.challenges.length){
    const empty=document.createElement('div');empty.className='empty';
    empty.textContent=portuguese?'Nenhum desafio está disponível agora.':'No challenges are available right now.';
    list.append(empty);
  }
  for(const challenge of page.challenges)list.append(challengeCard(challenge));
  statusElement.textContent=portuguese
    ?`Saldo atual: ${page.availableBalance} moeda${page.availableBalance===1?'':'s'}.`
    :`Current balance: ${page.availableBalance} coin${page.availableBalance===1?'':'s'}.`;
}

function challengeCard(challenge:ChallengeCard):HTMLElement{
  const card=document.createElement('article');card.className=`challenge-card ${challenge.action}`;
  const reward=document.createElement('span');reward.className='reward';reward.textContent=`+${challenge.rewardCoins}`;
  const heading=document.createElement('h2');heading.textContent=challenge.title;
  const message=document.createElement('p');message.textContent=challenge.message??(portuguese?'Visite este desafio e volte para confirmar suas moedas.':'Visit this challenge, then return to confirm your coins.');
  const button=document.createElement('button');button.type='button';
  button.textContent=challenge.action==='claimed'
    ?(portuguese?'Moedas recebidas':'Coins earned')
    :challenge.action==='claim'
      ?(portuguese?`Confirmar +${challenge.rewardCoins} moedas`:`Confirm +${challenge.rewardCoins} coins`)
      :(portuguese?'Abrir desafio':'Open challenge');
  button.disabled=challenge.action==='claimed';
  button.addEventListener('click',()=>void act(challenge,button));
  card.append(reward,heading,message,button);return card;
}

async function act(challenge:ChallengeCard,button:HTMLButtonElement):Promise<void>{
  button.disabled=true;
  statusElement.textContent=challenge.action==='visit'
    ?(portuguese?'Abrindo desafio...':'Opening challenge...')
    :(portuguese?'Adicionando moedas...':'Adding coins...');
  try{
    if(challenge.action==='visit'){
      const result=await request<{destinationUrl:string}>('visit',challenge.id);
      if(typeof result.destinationUrl!=='string')throw new Error('Challenge destination is unavailable.');
      location.href=result.destinationUrl;
      return;
    }
    await request('claim',challenge.id);
    await refresh();
  }catch(error){statusElement.textContent=error instanceof Error?error.message:'Reward failed.';button.disabled=false;}
}

function showError(message:string):void{
  list.replaceChildren();statusElement.textContent=message;
}

addEventListener('pageshow',()=>void refresh());

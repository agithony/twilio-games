import puppeteer from 'puppeteer-core';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const b=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swapchain']});
const p=await b.newPage();
await p.goto('http://localhost:5173/garage/',{waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});
await new Promise(r=>setTimeout(r,2000));
const res=await p.evaluate(async ()=>{
  const THREE=(await import('three'));
  const {GLTFLoader}=await import('three/examples/jsm/loaders/GLTFLoader.js');
  const {DRACOLoader}=await import('three/examples/jsm/loaders/DRACOLoader.js');
  const {stripDisplayBases}=await import('/asset-loader.ts');
  const {applyModelTransform}=await import('/model-transform.ts');
  const draco=new DRACOLoader();draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  const loader=new GLTFLoader();loader.setDRACOLoader(draco);
  const shoot=async(rot)=>{
    const gltf=await new Promise((res,rej)=>loader.load('/assets/18_mclaren_senna_crxw_widebody_kit_animated.glb',res,undefined,rej));
    const m=gltf.scene; stripDisplayBases(m); applyModelTransform(m,rot?{rotation:[0,180,0]}:{},4);
    const rend=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});rend.setSize(256,256);
    rend.outputColorSpace=THREE.SRGBColorSpace;
    const s=new THREE.Scene(); s.add(new THREE.HemisphereLight(0xffffff,0x445,2)); const k=new THREE.DirectionalLight(0xffffff,2);k.position.set(5,8,6);s.add(k);
    s.add(m); m.updateMatrixWorld(true);
    const box=new THREE.Box3().setFromObject(m);const c=new THREE.Vector3();box.getCenter(c);const sz=new THREE.Vector3();box.getSize(sz);
    const r=Math.max(sz.x,sz.y,sz.z,1);const cam=new THREE.PerspectiveCamera(38,1,0.05,2000);
    cam.position.set(c.x+r*0.72,c.y+r*0.42,c.z+r*1.15);cam.lookAt(c.x,c.y,c.z);cam.updateProjectionMatrix();
    rend.render(s,cam);const u=rend.domElement.toDataURL('image/png');rend.dispose();return u;
  };
  return { withRot: await shoot(true), noRot: await shoot(false) };
});
const fs=await import('node:fs/promises'); await fs.mkdir('tools/.smoke',{recursive:true});
for(const [k,u] of Object.entries(res)){ if(u){await fs.writeFile('tools/.smoke/rot-'+k+'.png',Buffer.from(u.split(',')[1],'base64'));console.log(k,'ok');}else console.log(k,'EMPTY'); }
await b.close();

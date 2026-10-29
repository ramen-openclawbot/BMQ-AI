import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { UncImage } from '@/lib/bmqAnalytics';

async function safeImage(blob: Blob): Promise<Blob> {
  if (!(blob instanceof Blob) || !blob.size || blob.size > 24*1024*1024) throw Error('invalid_image');
  const bytes=new Uint8Array(await blob.slice(0,12).arrayBuffer());
  const mime=bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':
    [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)?'image/png':
    ['GIF87a','GIF89a'].includes(String.fromCharCode(...bytes.slice(0,6)))?'image/gif':
    String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP'?'image/webp':null;
  if(!mime)throw Error('invalid_image');
  return new Blob([blob],{type:mime});
}
// Private browser object URLs only. Never persist image bytes or bearer URLs.
export function UncImageGallery({images,language,ownerId}:{images?:UncImage[];language:'vi'|'en';ownerId:string}) {
  const [loaded,setLoaded]=useState<Record<string,string>>({});
  const [failed,setFailed]=useState<string[]>([]);
  const [retry,setRetry]=useState(0);
  const [expanded,setExpanded]=useState<string|null>(null);
  const en=language==='en';
  useEffect(()=>{
    const controller=new AbortController(),urls:string[]=[];
    setLoaded({});setFailed([]);setExpanded(null);
    void(async()=>{
      for(const image of images??[]) {
        if(controller.signal.aborted)break;
        try {
          const {data,error}=await supabase.functions.invoke('bmq-analytics',{body:{action:'unc_image',id:image.id,language},signal:controller.signal});
          if(error)throw error;
          const blob=await safeImage(data);
          if(controller.signal.aborted)break;
          const url=URL.createObjectURL(blob);urls.push(url);
          setLoaded(current=>({...current,[image.id]:url}));
        } catch {
          if(!controller.signal.aborted)setFailed(current=>[...current,image.id]);
        }
      }
    })();
    return()=>{controller.abort();urls.forEach(url=>URL.revokeObjectURL(url));};
  },[images,ownerId,retry,language]);
  if(!images?.length)return null;
  return <div data-bmq-unc-images="private-v1" className="mt-3 space-y-3 whitespace-normal">
    {images.map((image,index)=><figure key={`${image.declarationId}:${image.id}`} className="min-w-0 rounded-[12px] bg-[var(--ac-well,#f7f7f5)] p-2">
      {loaded[image.id]?<button type="button" className="block min-h-11 w-full" onClick={()=>setExpanded(expanded===image.id?null:image.id)} aria-expanded={expanded===image.id} aria-label={`${en?'View UNC image':'Xem ảnh UNC'} ${index+1}`}>
        <img src={loaded[image.id]} alt={`UNC ${image.date.split('-').reverse().join('/')}, ${index+1}`} onError={()=>{setLoaded(current=>{const next={...current};delete next[image.id];return next;});setFailed(current=>[...current,image.id]);}} className={`mx-auto h-auto max-w-full rounded-lg object-contain ${expanded===image.id?'':'max-h-72'}`} />
      </button>:failed.includes(image.id)?<div role="status" className="text-[13px] text-[var(--ac-ink,#272727)]"><p>{en?'Could not load this image. Check your sign-in and retry.':'Chưa tải được ảnh. Kiểm tra đăng nhập rồi thử lại.'}</p><button type="button" className="min-h-11 font-medium text-[var(--ac-ink,#272727)] underline underline-offset-2" onClick={()=>setRetry(n=>n+1)}>{en?'Retry':'Thử lại'}</button></div>:<p role="status" className="min-h-11 text-[13px] text-[var(--ac-dim,#6b6b69)]">{en?'Loading image…':'Đang tải ảnh…'}</p>}
      <figcaption className="mt-2 text-[12px] text-[var(--ac-dim,#6b6b69)] [font-variant-numeric:tabular-nums]">UNC · {image.date.split('-').reverse().join('/')} · {index+1}/{images.length}</figcaption>
    </figure>)}
  </div>;
}

import type { CSSProperties } from "react";
const paths: Record<string, React.ReactNode> = {
  search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
  plus:<path d="M12 5v14M5 12h14"/>,check:<path d="m5 12 4.5 4.5L19 7"/>,close:<path d="m6 6 12 12M18 6 6 18"/>,
  chevron:<path d="m9 5 7 7-7 7"/>,
  document:<><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/></>,
  warehouse:<><path d="m3 9 9-6 9 6v12H3zM8 21v-8h8v8M3 9h18M10 17h4"/></>,
  oven:<><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 14h8M8 17h8M7 5V3m5 2V3m5 2V3"/></>,
  shelf:<><path d="M3 7h18M3 14h18M3 21h18M5 3v18M19 3v18M8 3h4v4M13 10h4v4M8 17h4v4"/></>,
  basket:<><path d="m3 9 2 11h14l2-11zM2 9h20M7 9l3-6m7 6-3-6M9 12v5m6-5v5"/></>,
  leaf:<><path d="M20 3C9 2 3 7 5 14s15 4 15-11Z"/><path d="M4 21 15 9"/></>,
  info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></>,
  machine:<><rect x="5" y="8" width="14" height="12" rx="3"/><path d="M9 8V4h6v4M3 11v5m18-5v5M9 13v1m6-1v1M9 17h6M8 20v2m8-2v2"/></>,
  spark:<><path d="m12 2 2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4Z"/></>,
};
export function Icon({name}:{name:string}){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">{paths[name]??paths.shelf}</svg>;}
export function GroveMark(){return <svg viewBox="0 0 40 40" className="grove-mark" aria-hidden="true"><path d="M7 18 20 7l13 11v15H7Z" fill="currentColor"/><path d="M16 33V21h8v12M12 17l8-7 8 7" fill="none" stroke="var(--color-paper)" strokeWidth="2.5" strokeLinejoin="round"/><path d="M24 6c2-5 7-4 9-4-1 6-4 8-9 7" fill="var(--color-sage)"/></svg>;}
export function GoodsIcon({group}:{group:string}){
 const wrap=(children:React.ReactNode)=> <svg viewBox="0 0 64 64" fill="none" stroke="var(--color-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
 const paper="var(--color-cream)",clay="var(--color-clay-light)",sage="var(--color-sage-light)",wheat="var(--color-wheat)";
 if(group==="dairy_fat"||group==="supplies")return wrap(<><path d="m19 21 6-10h15l6 10v31H19Z" fill={group==="supplies"?sage:paper}/><path d="M19 21h27M25 11l7 10V52M26 8h14v5H26Z" fill={sage}/><path d="M35 30h7v12h-7Z" fill={clay}/></>);
 if(group==="eggs")return wrap(<><path d="m9 43 9-7h29l8 7-6 11H15Z" fill={wheat}/>{[22,33,44].map((x,i)=><ellipse key={i} cx={x} cy={37-i%2*5} rx="7" ry="11" fill={paper}/>)}<path d="m9 43 9 4h29l8-4-6 11H15Z" fill={clay}/></>);
 if(group==="cheese")return wrap(<><path d="m10 36 35-15 9 12v18H10Z" fill={wheat}/><path d="m10 36 44-3M45 21v12"/><circle cx="24" cy="43" r="3" fill={paper}/><circle cx="44" cy="42" r="4" fill={paper}/><path d="m29 29 4 2"/></>);
 if(group==="vegetables")return wrap(<><path d="m38 23-21 30c-2 3-5 1-4-2l12-35Z" fill={clay}/><path d="M30 19c-6-16 0-17 5-5 10-12 15-6 4 1 15 0 14 7-1 8" fill={sage}/><path d="m21 29 6 4m-12 7 6 4"/></>);
 if(group==="meat_filling")return wrap(<><path d="M13 30C9 15 35 10 45 21c16 1 16 24 3 29-10 3-32-5-35-20Z" fill={clay}/><path d="M20 29c-2-8 17-10 23-2 14 2 10 16 2 17-7 2-23-7-25-15Z" fill={paper}/><path d="m26 26 14 14m-10-15 14 15"/></>);
 if(group==="packaging")return wrap(<><path d="m10 24 22-10 23 10v27L32 60 10 50Z" fill={wheat}/><path d="m10 24 22 10 23-10M32 34v26M20 19l23 10v12l-8 3V32Z" fill={paper}/></>);
 return wrap(<><path d="m21 12-4 9 1 6-7 24c-1 4 5 6 22 6s22-2 21-6l-7-24 1-6-5-9Z" fill={group==="sugar_additives"?paper:wheat}/><path d="M21 12h22M17 23h31"/><rect x="23" y="31" width="21" height="18" rx="3" fill={paper}/><path d="M33 35v11m0-6 5-3m-5 6-5-3" stroke="var(--color-sage)" strokeWidth="2"/></>);
}

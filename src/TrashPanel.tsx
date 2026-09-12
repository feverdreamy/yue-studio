import {useCallback,useEffect,useState} from 'react';
import {RotateCcw,Trash2} from 'lucide-react';
import {api} from './types';
import './trash.css';
export interface TrashEntry {id:string;kind:'take'|'job';originalId:string;title:string;deletedAt:string;bytes:number;}
const size=(bytes:number)=>bytes<1024*1024?`${Math.ceil(bytes/1024)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
export default function TrashPanel({revision,onChanged,onError}:{revision:number;onChanged:()=>void;onError:(message:string)=>void}){
 const [entries,setEntries]=useState<TrashEntry[]>([]),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);
 const refresh=useCallback(async()=>{const result=await api<{entries:TrashEntry[]}>('/api/trash');setEntries(result.entries);setSelected(ids=>ids.filter(id=>result.entries.some(item=>item.id===id)));},[]);
 useEffect(()=>{void refresh().catch(error=>onError(error.message));},[refresh,revision,onError]);
 async function restore(id:string){setBusy(true);try{await api(`/api/trash/${id}/restore`,{method:'POST',body:'{}'});await refresh();onChanged();}catch(error){onError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}}
 async function purge(){setBusy(true);try{await api('/api/trash/purge',{method:'POST',body:JSON.stringify({ids:selected,confirm:true})});setSelected([]);setConfirm(false);onChanged();}catch(error){onError(error instanceof Error?error.message:String(error));}finally{await refresh().catch(()=>{});setBusy(false);}}
 const selectedBytes=entries.filter(item=>selected.includes(item.id)).reduce((sum,item)=>sum+item.bytes,0);
 return <section className="trash-panel" aria-label="Deleted items"><div className="trash-intro"><p>Room for the next idea.<span>Deleted tracks and attempts stay here until you restore or permanently remove them.</span></p><span>{size(entries.reduce((sum,item)=>sum+item.bytes,0))} in Trash</span></div>
  {entries.length>0&&<div className="trash-toolbar"><label><input type="checkbox" aria-label="Select all trash items" disabled={busy} checked={selected.length===Math.min(entries.length,500)} onChange={event=>{setConfirm(false);setSelected(event.target.checked?entries.slice(0,500).map(item=>item.id):[]);}}/>{entries.length>500?'Select 500 items':'Select all'}</label><button className="text-button danger-text" disabled={busy||!selected.length} onClick={()=>setConfirm(true)}><Trash2 size={14}/>Permanently delete {selected.length||''}</button></div>}
  {confirm&&<div className="trash-confirm" role="alert"><strong>Permanently delete {selected.length} {selected.length===1?'item':'items'}?</strong><p>This frees {size(selectedBytes)}. The selected audio, settings and logs cannot be restored afterward.</p><div><button disabled={busy} onClick={()=>setConfirm(false)}>Keep in Trash</button><button className="danger-action" disabled={busy} onClick={()=>void purge()}>Delete permanently</button></div></div>}
  <div className="trash-list">{entries.map(entry=><article className="trash-row" key={entry.id}><input type="checkbox" aria-label={`Select deleted ${entry.title}`} checked={selected.includes(entry.id)} disabled={busy||selected.length>=500&&!selected.includes(entry.id)} onChange={event=>{setConfirm(false);setSelected(ids=>event.target.checked?[...ids,entry.id]:ids.filter(id=>id!==entry.id));}}/><div><strong>{entry.title}</strong><span>{entry.kind==='take'?'Track':'Generation attempt'} · {size(entry.bytes)} · {new Date(entry.deletedAt).toLocaleDateString()}</span></div><button className="text-button" disabled={busy} aria-label={`Restore deleted ${entry.title}`} onClick={()=>void restore(entry.id)}><RotateCcw size={14}/>Restore</button></article>)}</div>
  {!entries.length&&<div className="empty-register"><Trash2 size={30} strokeWidth={1}/><h3>Nothing left behind.</h3><p>Use the trash icon beside a track or finished attempt to move it here.</p></div>}
 </section>;
}

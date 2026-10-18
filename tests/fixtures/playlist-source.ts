import type {ReadApi} from '../../panel/client/library';
import {detail} from './read';
export function playlistProvider() {
  const playlists = [
    {id:8,name:'我喜欢',specialType:5,creator:{userId:7},subscribed:false},
    {id:9,name:'自己的歌单',specialType:0,creator:{userId:7},subscribed:false},
    {id:20,name:'他人的歌单',specialType:0,creator:{userId:99},subscribed:true},
  ];
  const calls: {path:string;data:Record<string,unknown>}[]=[];
  let uid='7';
  const read:ReadApi=async(path,data)=>{
    calls.push({path,data});
    if(path==='/api/w/nuser/account/get')return {code:200,profile:{userId:uid}};
    if(path==='/api/user/playlist')return {code:200,playlist:playlists,more:false};
    if(path==='/api/v6/playlist/detail'){
      const p=playlists.find(p=>String(p.id)===String(data.id));
      return {code:200,playlist:p?{...p,trackCount:2,trackIds:[{id:1},{id:2}],tracks:[detail(1),detail(2)]}:null};
    }
    throw Error('Unexpected synthetic request');
  };
  return {read,calls,playlists,setUid:(value:string)=>{uid=value;}};
}

import {normalizeSongId} from '../core/normalize';

export class PlaylistInputError extends Error {
  constructor() { super('请输入一个歌单 ID 或完整网易云歌单链接；短链接请打开后复制完整链接。'); }
}
export function parsePlaylistSource(input: string): {kind: 'playlist'; id: string} {
  try {
    const value=input.trim();
    if(/^\d+$/.test(value))return {kind:'playlist',id:normalizeSongId(value)};
    const links=value.match(/https?:\/\/[^\s<>「」“”]+/g);
    if(!links?.length)throw new PlaylistInputError();
    const ids=new Set<string>();
    for(const link of links){
      const url=new URL(link.replace(/[）)，。；、]+$/u,''));
      if(url.protocol!=='https:'||url.hostname!=='music.163.com'||url.port||url.username||url.password)throw new PlaylistInputError();
      const route=url.hash.startsWith('#/')?new URL(url.hash.slice(1),url.origin):url;
      if(route.origin!==url.origin||(route!==url&&(url.pathname!=='/'||url.searchParams.has('id'))))throw new PlaylistInputError();
      if(!['/playlist','/m/playlist'].includes(route.pathname)||route.searchParams.getAll('id').length!==1)throw new PlaylistInputError();
      const raw=route.searchParams.get('id')!;
      if(!/^\d+$/.test(raw))throw new PlaylistInputError();
      ids.add(normalizeSongId(raw));
    }
    if(ids.size!==1)throw new PlaylistInputError();
    return {kind:'playlist',id:[...ids][0]};
  }catch{throw new PlaylistInputError();}
}

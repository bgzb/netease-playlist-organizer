import {inspectOwner,sameOwner,readLocalTargets,validateTarget,buildReadExpression,evaluateRead,safeResult} from './verify-read-support.mjs';
// No arguments/environment destination overrides, lifecycle controls, writes, exports or raw errors.
try {
  if(process.argv.length!==2)throw new Error('不接受参数；仅验证已由启动器开启的本机 19319 主页面。');
  const expression=await buildReadExpression();
  const owner=inspectOwner();
  const url=validateTarget(await readLocalTargets());
  sameOwner(owner,inspectOwner());
  const result=safeResult(await evaluateRead(url,expression));
  sameOwner(owner,inspectOwner());
  console.log(JSON.stringify({client:{version:owner.version,build:owner.build},...result}));
  if(result.status!=='complete')process.exitCode=1;
} catch {
  console.error('只读验证未完成：请先通过启动器连接受支持的客户端；检查进程归属、版本、回环监听及主页面。不会自动重启或写入。');
  process.exitCode=1;
}

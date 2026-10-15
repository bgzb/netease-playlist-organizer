import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
test('source archive includes committed synthetic sources and excludes private/build paths; dirty tree is rejected',()=>{
  // Tests are bundled under work/test-build; locate the repository via cwd used by build-panel.
  const source=join(process.cwd(),'scripts/package-source.sh');
  const internalDocs=['CONTRIBUTING.md','SECURITY.md','docs/PUBLISHING.md','docs/RELEASE_NOTES.md','docs/read-verification.md','docs/access-verification.md','docs/design.md','docs/implementation-plan.md','docs/release-validation-2026-10-15.md','docs/runtime-contract.md','docs/scan-performance.md','docs/future-report.md','tests/test-report.md','NOTES.md'];
  const fixture=mkdtempSync(join(tmpdir(),'ncm-source-package-'));
  const run=(cmd,args)=>execFileSync(cmd,args,{cwd:fixture,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try {
    mkdirSync(join(fixture,'scripts'));copyFileSync(source,join(fixture,'scripts/package-source.sh'));
    for(const path of ['README.md','package-lock.json','tests/fixtures/synthetic.ts','work/private.json','node_modules/private.txt','.superpowers/private.md','launcher/.build/private.txt','caches/private.txt','docs/read-verification.md','docs/access-verification.md','docs/design.md','docs/implementation-plan.md','LICENSE','CHANGELOG.md','THIRD_PARTY_NOTICES.md','docs/INSTALL.md','.github/workflows/ci.yml','.nvmrc',...internalDocs]) {
      mkdirSync(dirname(join(fixture,path)),{recursive:true});writeFileSync(join(fixture,path),path.includes('private')||internalDocs.includes(path)?'PRIVATE_DATA /Users/private-person/secret':'SYNTHETIC_SOURCE');
    }
    writeFileSync(join(fixture,'.gitignore'),'work/\n');
    run('git',['init','-q','-b','main']);run('git',['add','-f','.']);
    run('git',['-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic source']);
    run('/bin/bash',['scripts/package-source.sh']);
    const archive=join(fixture,'work/dist/网易云歌单整理源码.zip');
    const list=run('/usr/bin/unzip',['-Z1',archive]);
    for(const path of ['README.md','package-lock.json','tests/fixtures/synthetic.ts','LICENSE','CHANGELOG.md','THIRD_PARTY_NOTICES.md','docs/INSTALL.md','.github/workflows/ci.yml','.nvmrc'])assert.ok(list.includes('netease-playlist-organizer/'+path));
    for(const path of ['work/','node_modules/','.superpowers/','.build/','caches/','docs/read-verification.md','docs/access-verification.md','docs/design.md','docs/implementation-plan.md','.git/',...internalDocs])assert.equal(list.includes(path),false);
    assert.equal(run('/usr/bin/unzip',['-p',archive]).includes('PRIVATE_DATA'),false);
    assert.equal(run('/usr/bin/unzip',['-p',archive]).includes('/Users/private-person/'),false);
    const before=readFileSync(archive);writeFileSync(join(fixture,'README.md'),'DIRTY_SOURCE');
    assert.throws(()=>run('/bin/bash',['scripts/package-source.sh']));assert.deepEqual(readFileSync(archive),before);
  } finally {rmSync(fixture,{recursive:true,force:true});}
});


test('public export extracts committed ZIP without history and refuses dirty source or existing destination',()=>{
  const fixture=mkdtempSync(join(tmpdir(),'ncm-public-export-'));
  const run=(cmd,args)=>execFileSync(cmd,args,{cwd:fixture,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try {
    mkdirSync(join(fixture,'scripts'));
    for(const name of ['package-source.sh','export-public.sh'])copyFileSync(join(process.cwd(),'scripts',name),join(fixture,'scripts',name));
    writeFileSync(join(fixture,'README.md'),'PUBLIC_COMMITTED');writeFileSync(join(fixture,'.gitignore'),'work/\n');
    run('git',['init','-q','-b','main']);run('git',['add','.']);
    run('git',['-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic source']);
    run('/bin/bash',['scripts/export-public.sh']);
    const destination=join(fixture,'work/public-release');
    assert.equal(readFileSync(join(destination,'README.md'),'utf8'),'PUBLIC_COMMITTED');
    assert.throws(()=>readFileSync(join(destination,'.git/HEAD')));
    writeFileSync(join(destination,'KEEP'),'DO_NOT_OVERWRITE');
    assert.throws(()=>run('/bin/bash',['scripts/export-public.sh']));
    assert.equal(readFileSync(join(destination,'KEEP'),'utf8'),'DO_NOT_OVERWRITE');
    writeFileSync(join(fixture,'README.md'),'DIRTY');
    assert.throws(()=>run('/bin/bash',['scripts/export-public.sh','public-next']));
    assert.throws(()=>readFileSync(join(fixture,'work/public-next/README.md')));
  } finally {rmSync(fixture,{recursive:true,force:true});}
});


test('repository ignore rules keep essential docs and code while excluding internal reports',()=>{
  const fixture=mkdtempSync(join(tmpdir(),'ncm-document-policy-'));
  const run=(cmd,args)=>execFileSync(cmd,args,{cwd:fixture,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try {
    copyFileSync(join(process.cwd(),'.gitignore'),join(fixture,'.gitignore'));
    const kept=['README.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','LICENSE','docs/INSTALL.md','tests/scan.test.ts','launcher/Tests/Example.swift'];
    const ignored=['CONTRIBUTING.md','SECURITY.md','docs/PUBLISHING.md','docs/design.md','docs/release-validation-2026-10-15.md','docs/future-report.md','tests/test-report.md','NOTES.md'];
    for(const name of [...kept,...ignored]) {
      mkdirSync(dirname(join(fixture,name)),{recursive:true});writeFileSync(join(fixture,name),'fixture');
    }
    run('git',['init','-q','-b','main']);
    run('git',['add','.']);
    const tracked=run('git',['ls-files']).split('\n');
    for(const name of kept)assert.ok(tracked.includes(name),name);
    for(const name of ignored)assert.equal(tracked.includes(name),false,name);
  } finally {rmSync(fixture,{recursive:true,force:true});}
});

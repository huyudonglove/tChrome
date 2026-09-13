import {test, expect} from 'bun:test';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {patchScript, readScript} from './store.ts';
const add = (name = 'demo.js') => `--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+one\n`;
const edit = (old = 'one', next = 'two') => `--- a/demo.js\n+++ b/demo.js\n@@ -1 +1 @@\n-${old}\n+${next}\n`;
const temp = async (run: (dir:string)=>Promise<void>) => {
 const dir=await mkdtemp(join(tmpdir(),'tchrome-store-test-'));
 try {await run(dir);} finally {await rm(dir,{recursive:true,force:true});}
};
test('real git recounts hunks to create, modify and delete scripts without executing content', () => temp(async dir => {
 expect((await patchScript(dir,{filename:'demo.js',patch:add().replace('@@ -0,0 +1 @@','@@ -0,0 +1,99 @@')})).ok).toBe(true);
 expect((await readScript(dir,'demo.js')).code).toBe('one\n');
 expect((await patchScript(dir,{filename:'demo.js',patch:edit().replace('@@ -1 +1 @@','@@ -1,9 +1,7 @@')})).ok).toBe(true);
 expect((await readScript(dir,'demo.js')).code).toBe('two\n');
 expect(await patchScript(dir,{filename:'demo.js',patch:'--- a/demo.js\n+++ /dev/null\n@@ -1,9 +0,0 @@\n-two\n'})).toMatchObject({ok:true,operation:'deleted',bytes:0});
 await expect(readScript(dir,'demo.js')).rejects.toThrow();
}));
test('invalid and out of scope patches leave original bytes unchanged',()=>temp(async dir=>{
 await patchScript(dir,{filename:'demo.js',patch:add()});
 for(const patch of [edit('missing'),edit().trimEnd(),add('other.js'),edit()+add('other.js'),add('../escape.js'),
 'diff --git a/demo.js b/demo.js\nold mode 100644\nnew mode 100755\n',
 'diff --git a/demo.js b/other.js\nsimilarity index 100%\nrename from demo.js\nrename to other.js\n',
 'diff --git a/link.js b/link.js\nnew file mode 120000\n--- /dev/null\n+++ b/link.js\n@@ -0,0 +1 @@\n+/tmp/outside\n']) {
 expect((await patchScript(dir,{filename:'demo.js',patch})).ok).toBe(false);
 expect((await readScript(dir,'demo.js')).code).toBe('one\n');
 }
 for(const filename of ['../demo.js','demo.txt','/tmp/demo.js','a/b.py','-demo.sh']) expect((await patchScript(dir,{filename,patch:add()})).ok).toBe(false);
}));
test('rejects target symlinks, directories and symlink scripts roots',()=>temp(async dir=>{
 const outside=join(dir,'outside');await writeFile(outside,'protected');await mkdir(join(dir,'scripts'));
 await symlink(outside,join(dir,'scripts','demo.js'));
 expect((await patchScript(dir,{filename:'demo.js',patch:edit('protected')})).ok).toBe(false);
 await expect(readScript(dir,'demo.js')).rejects.toThrow();
 expect(await readFile(outside,'utf8')).toBe('protected');
 await rm(join(dir,'scripts','demo.js'));await mkdir(join(dir,'scripts','demo.js'));
 expect((await patchScript(dir,{filename:'demo.js',patch:add()})).ok).toBe(false);
 await rm(join(dir,'scripts'),{recursive:true});await mkdir(join(dir,'elsewhere'));await symlink(join(dir,'elsewhere'),join(dir,'scripts'));
 expect((await patchScript(dir,{filename:'demo.js',patch:add()})).ok).toBe(false);
}));
test('concurrent patches for the same data directory apply in submission order',()=>temp(async dir=>{
 const results=await Promise.all([patchScript(dir,{filename:'demo.js',patch:add()}),patchScript(dir,{filename:'demo.js',patch:edit()}),patchScript(dir,{filename:'demo.js',patch:edit('two','three')})]);
 expect(results.map(r=>r.ok)).toEqual([true,true,true]);
 expect((await readScript(dir,'demo.js')).code).toBe('three\n');
}));
test('list includes ordinary scripts and read/patch preserve large files',()=>temp(async dir=>{
 const {listScripts}=await import('./store.ts');
 expect(await listScripts(dir)).toEqual([]);
 await mkdir(join(dir,'scripts'));
 await writeFile(join(dir,'scripts','good.py'),'pass\n');
 await writeFile(join(dir,'scripts','ignored.txt'),'text');
 await symlink(join(dir,'scripts','good.py'),join(dir,'scripts','linked.py'));
 await mkdir(join(dir,'scripts','folder.js'));
 expect(await listScripts(dir)).toEqual([{filename:'good.py',bytes:5}]);
 await writeFile(join(dir,'scripts','big.js'),'x'.repeat(1_048_577));
 expect((await readScript(dir,'big.js')).code.length).toBe(1_048_577);
 expect((await patchScript(dir,{filename:'demo.js',patch:'--- /dev/null\n+++ b/demo.js\n@@ -0,0 +1 @@\n+'+'x'.repeat(2_097_153)+'\n'})).ok).toBe(true);
 expect((await readScript(dir,'demo.js')).code.length).toBe(2_097_154);
}));

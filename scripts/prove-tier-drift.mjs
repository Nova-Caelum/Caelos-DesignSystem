// Each case gets its own staged change. Check the same snapshot with the CI
// command and a real git commit, then verify that HEAD did not advance.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'caelos-tier-proof-'));
const scratch = path.join(temp, 'repo');
mkdirSync(scratch);
const probe = 'src/tiers/1-primitives/probe';
const catalog = 'token_catalog/01-primitives.tokens.json';
const style = (key, val) => 'export const recipe = { ' + key + ': ' + JSON.stringify(val) + ' };';
const css = (key, val) => '.probe { ' + key + ': ' + val + ' }';
const named = 'cy' + 'an';
const raw = 'raw style value';
const cases = [
  ['shorthand','ts',style('px','13.37px'),raw],
  ['original padding regression','css',css('padding','13.37px'),raw],
  ['grid','ts',style('gridTemplateColumns','13.37px 1fr'),raw],
  ['percentage','css',css('width','13.37%'),raw],
  ['named colour','ts',style('backgroundColor',named),raw],
  ['system colour','ts',style('color','Canvas'+'Text'),raw],
  ['palette colour copied into style','ts',style('color','#'+'080817'),raw],
  ['color mix weight','css',css('color','color-mix(in srgb, currentColor 13%, transparent)'),raw],
  ['calc multiplier','css',css('gap','calc(var(--sys-space-stack) * 1.37)'),raw],
  ['var fallback','css',css('gap','var(--sys-space-stack, 13px)'),'token fallback'],
  ['unknown CSS role','css',css('color','var(--il-ink)'),'unknown token'],
  ['JSX numeric prop','tsx','export const item = <Icon size={13} />;',raw],
  ['SVG numeric attribute','tsx','export const item = <path strokeWidth={1.37} />;',raw],
  ['SVG file style attribute','svg','<svg><path stroke-width="1.37" /></svg>',raw],
  ['motion object','tsx','export const item = <motion.div transition={{ duration: 0.137 }} />;',raw],
  ['DOM assignment','ts','el.style.width = "13.37px";',raw],
  ['DOM custom property','ts','el.style.setProperty("--probe", "13.37px");',raw],
  ['DOM style text','ts','el.style.cssText = "padding: 13.37px";',raw],
  ['DOM attribute','ts','el.setAttribute("style","padding: 13.37px");',raw],
  ['timer','ts','setTimeout(run, 337);',raw],
  ['interval','ts','setInterval(run, 337);',raw],
  ['JSX style element','tsx','export const item = <style>{".p { gap: 13px }"}</style>;',raw],
  ['HTML style element','index.html','<style>.x { padding: 13.37px }</style>',raw],
  ['HTML inline style','index.html','<span style="padding: 13.37px"></span>',raw],
  ['tagged CSS template','ts','const rule = styled.div' + '\x60' + 'padding: 13.37px' + '\x60;',raw],
  ['dynamic template','ts','const n=13.37; const s={width:' + '\x60' + '\x24{n}px' + '\x60};',raw],
  ['Tailwind arbitrary utility','tsx','export const item=<div className="hover:w-[13px]" />;','arbitrary utility'],
  ['suppression on clean code','ts','// token-'+'exempt(bogus)\nexport const ok=true;','suppression comment'],
  ['constant concatenation','ts','const n=13.37; const s={width:n+"px"};',raw],
  ['computed key','ts','const prop="width"; const s={[prop]:"13px"};',raw],
  ['cast','ts','const s={width:"13px" as any};',raw],
  ['conditional','ts','const s={width:enabled?"13px":"auto"};',raw],
  ['numeric opacity','ts',style('opacity',0.137),raw],
  ['stack order','ts',style('zIndex',1337),raw],
  ['motion time','ts',style('transitionDuration','137ms'),raw],
  ['transform multiplier','ts',style('transform','scale(.1337)'),raw],
  ['default parameter','ts','function view(sideOffset=8) {}',raw],
  ['design constant','ts','export const CHAT_GAP = 13.37;',raw],
  ['comments in strings','ts','const s={content:"//",padding:"13.37px"};',raw],
  ['multiline numeric','ts','const s={top:\n1337};',raw],
  ['media breakpoint','scss','@media (min-width: 1337px) { .x { display: block } }',raw],
  ['recipe in root config','panda.config.ts','defineRecipe({base:{padding:"13.37px"}});',raw],
  ['slot recipe','ts','defineSlotRecipe({base:{root:{margin:"13.37px"}}});',raw],
  ['global CSS','ts','defineGlobalStyles({body:{padding:"13.37px"}});',raw],
  ['keyframes','theme/keyframes.ts','export const frames={from:{opacity:0.137}};',raw],
  ['fixtures directory','tests/fixtures/probe.ts',style('borderRadius','13px'),raw],
  ['imported JSON style data','preview/settings.json','{"padding":"13.37px"}',raw],
  ['imported JSON value at style sink','ts','import data from "../0-foundations/data.json"; const s={padding:data.measure};',raw],
  ['upward import','ts','import "../2-controls/probe";','import must point down'],
  ['sibling re-export','ts','export * from "./sibling";','import must point down'],
  ['dynamic import','ts','import("../2-controls/probe");','import must point down'],
  ['require','ts','require("../2-controls/probe");','import must point down'],
  ['CSS import','css','@import "../2-controls/probe.css";','import must point down'],
  ['unclassified local dependency','ts','import "../../../preview/probe";','unclassified tier import'],
  ['same-tier source token','ts','token("primitives.shared.spacing.stack");','token must point down'],
  ['unknown source token','ts','token("sys.missing");','unknown token'],
  ['upward catalog alias',catalog,'{units.chat.composer-root.shell-top}','catalog alias must point down'],
  ['sibling catalog alias',catalog,'{primitives.shared.spacing.stack}','catalog alias must point down'],
  ['missing catalog alias',catalog,'{sys.unknown}','unknown catalog token'],
  ['unclassified source','src/loose.ts','export const loose=true;', 'unclassified source tier'],
  ['separate catalog','extra/99-side.tokens.json','{"extra":{"$value":"x"}}','unclassified token catalog'],
  ['second foundation file','token_catalog/00-extra.tokens.json','{"base":{"extra":{"$value":13}}}', 'raw foundations must use the foundation catalog'],
  ['literal font family','ts',style('fontFamily','Example Sans'),'raw font family'],
  ['trailing suppression','ts','const ok=true; // token-'+'exempt(bogus)','suppression comment'],
  ['raw catalog input',catalog,13.37,'raw catalog value'],
];

function command(bin, args, cwd=scratch) {
  return spawnSync(bin,args,{cwd,encoding:'utf8',maxBuffer:16*1024*1024});
}
function ok(bin,args,cwd) {
  const r=command(bin,args,cwd);
  assert.equal(r.status,0,r.stderr+r.stdout);
  return r.stdout.trim();
}
function write(file,body) {
  const dest=path.join(scratch,file);
  mkdirSync(path.dirname(dest),{recursive:true});
  writeFileSync(dest,body);
}
const git=(...args)=>ok('git',args);
function ci() { return command('sh',[path.join(project,'scripts/check-tier-index.sh'),scratch]); }
try {
  ok('git',['checkout-index','--all','--prefix='+scratch+'/'],project);
  git('init','--quiet');
  git('config','user.email','tier-proof@example.invalid');
  git('config','user.name','Tier drift proof');
  mkdirSync(path.join(scratch,'node_modules'));
  for (const dep of ['husky','typescript']) symlinkSync(path.join(project,'node_modules',dep),path.join(scratch,'node_modules',dep),'dir');
  ok(process.execPath,[path.join(project,'node_modules/husky/bin.js')]);
  assert.equal(git('config','--get','core.hooksPath'),'.husky/_');
  write('src/tiers/0-foundations/probe.ts','export const role = "sys.space.stack";\n');
  write('src/tiers/0-foundations/data.json',JSON.stringify({measure:'13.37px'}));
  write(probe+'.ts','import { role } from "../0-foundations/probe";\nexport const s = { padding: token("sys.space.stack") };\n');
  write(probe+'.css','.probe { padding: var(--sys-space-stack); }\n');
  git('add','.');
  const clean=ci();
  assert.equal(clean.status,0,clean.stderr+clean.stdout);
  git('commit','--quiet','-m','Clean lower-tier reference and import');
  const initial=git('rev-parse','HEAD');
  console.log('ACCEPT · lower-tier import, source token, CSS token and clean catalog · hook + CI');
  for (const [label,ext,body,reason] of cases) {
    const file=ext.includes('.') ? ext : probe+'.'+ext;
    if (file===catalog) {
      const obj=JSON.parse(readFileSync(path.join(scratch,file)));
      obj.primitives.shared.scrollArea['light-ink'].$value=body;
      write(file,JSON.stringify(obj));
    } else write(file,body+'\n');
    git('add','--',file);
    const direct=ci();
    const hook=command('git',['commit','--quiet','-m',label]);
    for (const [which,result] of [['CI',direct],['hook',hook]]) {
      assert.equal(result.status,1,label+' '+which+': '+result.stderr+result.stdout);
      assert.ok((result.stderr+result.stdout).includes(reason),label+' '+which+' refused for wrong reason: '+result.stderr+result.stdout);
    }
    assert.equal(git('rev-parse','HEAD'),initial);
    console.log('REJECT · '+label+' · '+reason+' · hook + CI');
    git('restore','--source=HEAD','--staged','--worktree','--',file);
  }
  assert.equal(git('status','--porcelain'),'');
  console.log(cases.length+' violations rejected twice; clean commit accepted.');
} finally {
  rmSync(temp,{recursive:true,force:true});
}

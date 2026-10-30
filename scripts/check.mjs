#!/usr/bin/env node
// Проверка на българския правопис: речник (hunspell bg_BG) + правила, които се хващат механично.
// Употреба: node check.mjs <файл|папка|url> ... [--json] [--no-dict] [--ignore файл]
// Членуването по роля в изречението, запетаите и стила не се хващат тук — те са за прочита (SKILL.md).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.PRAVOPIS_DICT || path.join(os.homedir(), '.cache', 'pravopis');
const DICT_URL = 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/bg_BG/';
const EXT = new Set(['.html', '.htm', '.md', '.txt', '.jsx', '.tsx', '.js', '.ts', '.mjs', '.cjs', '.vue', '.svelte', '.json', '.docx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor']);

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const targets = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--ignore');
if (!targets.length) {
  console.error('Употреба: node check.mjs <файл|папка|url> ... [--json] [--no-dict] [--ignore файл]');
  process.exit(2);
}

// ---------- речникът ----------
async function loadSpell() {
  if (flag('--no-dict')) return null;
  fs.mkdirSync(CACHE, { recursive: true });
  for (const f of ['bg_BG.aff', 'bg_BG.dic']) {
    const p = path.join(CACHE, f);
    if (!fs.existsSync(p)) {
      process.stderr.write(`Свалям ${f} (речникът на bgoffice / LibreOffice, GPL)…\n`);
      const r = await fetch(DICT_URL + f);
      if (!r.ok) throw new Error(`Речникът не се свали: ${r.status}`);
      fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
    }
  }
  const { default: nspell } = await import('nspell');
  return nspell(fs.readFileSync(path.join(CACHE, 'bg_BG.aff')), fs.readFileSync(path.join(CACHE, 'bg_BG.dic')));
}

// Думи, които речникът не знае, но са верни: имена, марки, термини. Една на ред; # е коментар.
function loadIgnore() {
  const words = new Set();
  const files = [path.join(HERE, '..', 'ignore.txt'), opt('--ignore'), '.pravopis-ignore'].filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const w = l.replace(/#.*/, '').trim();
      if (w) words.add(w.toLowerCase());
    }
  }
  return words;
}

// ---------- текстът ----------
const CYR = /[А-Яа-яЀ-ӿ]/;
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
  .replace(/&bdquo;/g, '„').replace(/&ldquo;/g, '“').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

// Връща [{line, text}] — само парчета с кирилица.
function extract(file, src) {
  const ext = path.extname(file).toLowerCase();
  const out = [];
  const push = (line, t) => { t = decode(t).replace(/\s+/g, ' ').trim(); if (t && CYR.test(t)) out.push({ line, text: t }); };
  if (ext === '.md' || ext === '.txt') {
    src.split(/\r?\n/).forEach((l, i) => push(i + 1, l.replace(/`[^`]*`/g, 'X')));
  } else if (ext === '.html' || ext === '.htm' || ext === '.vue' || ext === '.svelte') {
    const clean = src.replace(/<(script|style)[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    clean.split(/\r?\n/).forEach((l, i) => {
      l.replace(/(?:alt|title|placeholder|aria-label|content)="([^"]*)"/g, (_, v) => { push(i + 1, v); return ''; });
      push(i + 1, l.replace(/<[^>]*>/g, ' '));
    });
  } else {
    // JS/TS/JSX и JSON: низовете и текстът в JSX. Коментарите се пропускат.
    const lines = src.split(/\r?\n/);
    let inBlock = false;
    lines.forEach((l, i) => {
      let s = l;
      if (inBlock) { const e = s.indexOf('*/'); if (e < 0) return; s = s.slice(e + 2); inBlock = false; }
      s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
      const b = s.indexOf('/*'); if (b >= 0) { inBlock = true; s = s.slice(0, b); }
      s = s.replace(/(^|[^:"'`\\])\/\/.*$/, '$1');
      const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`|>([^<>{}]*)</g;
      let m;
      while ((m = re.exec(s))) push(i + 1, (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/\$\{[^}]*\}/g, ' X ').replace(/\\n/g, ' '));
    });
  }
  return out;
}

function docxText(buf) {
  // Чете word/document.xml от .docx без външни пакети (zip с deflate).
  let i = 0; const parts = [];
  while ((i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i)) >= 0) {
    const method = buf.readUInt16LE(i + 8), csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26), xlen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nlen).toString();
    const start = i + 30 + nlen + xlen;
    if (name === 'word/document.xml') {
      const data = buf.slice(start, start + csize);
      const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
      return xml.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '').replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, ' | ').replace(/<[^>]+>/g, '');
    }
    i = start + csize; parts.push(name);
  }
  return '';
}

// ---------- правилата ----------
// Всяко правило: id, regex, съобщение, предложение (функция по съвпадението). Източник — references/pravila.md.
const W = '[А-Яа-яЀ-ӿ]';
const RULES = [
  { id: 'vav', re: new RegExp(`(^|[^${W.slice(1, -1)}])(в) ([вфВФ]${W}*)`, 'g'), msg: '„във“ пред дума с „в“ или „ф“', fix: (m) => `във ${m[3]}` },
  { id: 'vav-izlishno', re: new RegExp(`(^|[^${W.slice(1, -1)}])(във) ([^вфВФ\\d\\s„"(A-Za-z]${W}*)`, 'gi'), msg: '„в“ пред дума, която не започва с „в“ или „ф“', fix: (m) => `в ${m[3]}` },
  { id: 'sas', re: new RegExp(`(^|[^${W.slice(1, -1)}])(с) ([сзСЗ]${W}*)`, 'g'), msg: '„със“ пред дума със „с“ или „з“', fix: (m) => `със ${m[3]}` },
  { id: 'sas-izlishno', re: new RegExp(`(^|[^${W.slice(1, -1)}])(със) ([^сзСЗ\\d\\s„"(A-Za-z]${W}*)`, 'gi'), msg: '„с“ пред дума, която не започва със „с“ или „з“', fix: (m) => `с ${m[3]}` },
  { id: 'i-kratko', re: new RegExp(`(^|[^${W.slice(1, -1)}])(й)(?=[^${W.slice(1, -1)}]|$)`, 'g'), msg: 'местоимението „на нея“ се пише „ѝ“ (с ударение), не „й“', fix: () => 'ѝ' },
  { id: 'kavichki', re: /(^|[\s(])"([^"]*[А-Яа-я][^"]*)"/g, msg: 'българските кавички са „…“', fix: (m) => `„${m[2]}“` },
  { id: 'kavichki-nesavpadasht', re: /„([^„“”"\n]{1,160})["”]/g, msg: 'кавичката отваря „ и затваря с английска — затваря се с “', fix: (m) => `„${m[1]}“` },
  { id: 'kavichki-en',re: /“([^”“„]*[А-Яа-я][^”“„]*)”/g, msg: 'българските кавички са „…“ (долна отваря, горна затваря)', fix: (m) => `„${m[1]}“` },
  { id: 'tire', re: new RegExp(`(${W}|[\\d,.)%€"“»])\\s+-\\s+(${W}|[\\d„"])`, 'g'), msg: 'между думи е тире (–), не дефис (-)', fix: (m) => `${m[1]} – ${m[2]}` },
  { id: 'interval-predi-znak', re: new RegExp(`(${W}) +([,.;:]|[!?](?=\\s*$|\\s+[А-ЯA-Z„"]))(?=\\s|$)`, 'g'), msg: 'без интервал преди препинателен знак', fix: (m) => `${m[1]}${m[2]}` },
  { id: 'interval-sled-zapetaya', re: new RegExp(`(${W}),(${W})`, 'g'), msg: 'интервал след запетая', fix: (m) => `${m[1]}, ${m[2]}` },
  { id: 'dvoen-interval', re: /\S( {2,})\S/g, msg: 'двоен интервал', fix: () => ' ' },
  { id: 'hilyadi', re: /(^|[^\d.,\/:-])(\d{1,3}),(\d{3})(?!\d)/g, msg: 'хилядите се отделят с интервал, не със запетая (25 000); запетаята е десетична', fix: (m) => `${m[2]} ${m[3]}` },
  // Номерата (ЕИК, ЕГН, телефон, номер на поръчка) не се групират — затова: не след такава дума и не с водеща нула.
  { id: 'hilyadi-slyato', re: /(^|(?<!(?:ЕИК|ЕГН|БУЛСТАТ|ИН|тел|№|код|ID|IBAN|заявка|поръчка|фактура|бон|реф|ref)\.?:?\s?)[^\d.,\/:#_A-Za-z-])([1-9]\d{4,6})(?![\d.,A-Za-z])/g, msg: 'числата над 9 999 се групират по три с интервал', fix: (m) => m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') },
  { id: 'desetichna-tochka', re: new RegExp(`(${W}[^.]{0,40}\\s)(\\d+)\\.(\\d{1,2})(?![\\d.])(?=\\s|[%€]|$)`, 'g'), msg: 'десетичният знак е запетая (1,7), не точка', fix: (m) => `${m[2]},${m[3]}`,
    // „12.10“ е по-често дата (ден.месец) — само за преглед.
    softIf: (m) => m[3].length === 2 && +m[2] >= 1 && +m[2] <= 31 && +m[3] >= 1 && +m[3] <= 12 },
  { id: 'myarka', re: /(^|[^\dA-Za-z.,])(\d+(?:,\d+)?)(кг|гр|г|мг|мкг|мл|л|см|мм|км|м²|м|мин|сек|ч|ккал|kcal|kg|g|ml|cm|km|лв)(?![А-Яа-яA-Za-z\d²])/g, msg: 'интервал между числото и мярката (10 кг, 200 мл)', fix: (m) => `${m[2]} ${m[3]}` },
  { id: 'evro', re: /(\d(?:[\d ]*\d)?)(€)/g, msg: 'интервал между числото и € (25 €)', fix: (m) => `${m[1]} €` },
  { id: 'po-nai', re: /(^|[^А-Яа-я])(по|най|По|Най) (добр|лош|голям|голем|малк|висок|висш|нис|бърз|бави|лесн|трудн|скъп|евтин|нов|стар|важн|дълг|кратк|къс|силн|слаб|чест|често|много|малко|близ|далеч|рано|късно|хубав|прост|ясн|сигурн|точн|бързо|лесно|трудно|добре|зле|удобн|вкусн|здравослов|подходящ|изгодн|скоро)([А-Яа-я]*)/g, msg: '„по-“ и „най-“ се пишат с дефис', fix: (m) => `${m[2]}-${m[3]}${m[4]}`,
    // „по“ + членувано прилагателно е най-често предлог („търси по краткото име“) — само за преглед.
    softIf: (m) => /^[Пп]о$/.test(m[2]) && /(ия|ият|ата|ото|ите)$/.test(m[3] + m[4]) },
  { id: 'ne-slyato', re: /(^|[^А-Яа-я])(незнам|немога|неискам|нямам да|неможе|незнае|неща да)(?=[^А-Яа-я]|$)/gi, msg: '„не“ пред глагол се пише отделно', fix: (m) => m[2].replace(/^не/i, (x) => x + ' ') },
  { id: 'zapetaya-v-saiuz', re: /(въпреки|тъй|така|след|без|за|преди), (че|като|да)(?=[^А-Яа-я])/gi, msg: 'съставният съюз не се разделя със запетая („въпреки че“, „тъй като“, „така че“, „без да“, „за да“)', fix: (m) => `${m[1]} ${m[2]}` },
  // Дума с кирилица и латиница наведнъж — обикновено латинско „е/о/а/р/с“ вътре в българска дума, невидимо за окото.
  { id: 'smesena-azbuka', re: /[А-Яа-яЀ-ӿ]+[A-Za-z]+[А-Яа-яЀ-ӿA-Za-z]*|[A-Za-z]+[А-Яа-яЀ-ӿ]+[А-Яа-яЀ-ӿA-Za-z]*/g, msg: 'дума със смесени кирилица и латиница', fix: (m) => m[0].replace(/[aeopcxyAEOPCXHKMBT]/g, (c) => ({ a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', A: 'А', E: 'Е', O: 'О', P: 'Р', C: 'С', X: 'Х', H: 'Н', K: 'К', M: 'М', B: 'В', T: 'Т' })[c]) },
  { id: 'mnogotochie', re: /([А-Яа-я])\.\.\.(?!\.)/g, msg: 'многоточието е един знак (…) — по избор, но еднакво в целия текст', fix: (m) => `${m[1]}…`, soft: true },
];

// Пълен член след предлог: „на сайтът“, „в магазинът“ — след предлог винаги е кратък член.
const PREP = 'в|във|на|с|със|за|от|до|по|при|към|след|пред|под|над|без|през|между|чрез|у|около|срещу|заради|освен|покрай|сред|из|от|според';
// Между предлога и съществителното може да има прилагателно с кратък член от мъжки род (-ия), само с малка буква:
// „на големия магазинът“. Женско/средно (-ата, -ото) не може да стои пред съществително от мъжки род, а главна буква е име („В България форматът“).
const PREP_ANY = PREP.split('|').map((p) => `[${p[0].toUpperCase()}${p[0]}]${p.slice(1)}`).join('|');
const PREP_RE = new RegExp(`(^|[^А-Яа-я])(${PREP_ANY}) ((?:[а-я]+ия )?)([а-я]{3,}(?:ът|ят))(?=[^А-Яа-я]|$)`, 'g');

function checkPiece(text, spell, ignore) {
  const hits = [];
  for (const r of RULES) {
    r.re.lastIndex = 0; let m;
    while ((m = r.re.exec(text))) {
      hits.push({ rule: r.id, msg: r.msg, at: text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25), fix: r.fix(m), soft: !!r.soft || !!(r.softIf && r.softIf(m)) });
      if (m[0].length === 0) r.re.lastIndex++;
    }
  }
  PREP_RE.lastIndex = 0; let m;
  while ((m = PREP_RE.exec(text))) {
    const w = m[4], base = w.slice(0, -2);
    if (spell && !(spell.correct(base) || spell.correct(base + 'а') || spell.correct(base.replace(/и$/, '')))) continue;
    hits.push({ rule: 'palen-chlen-predlog', msg: 'след предлог е кратък член (-а/-я), не пълен (-ът/-ят)', at: m[0].trim(), fix: `${m[2]} ${m[3]}${w.replace(/ът$/, 'а').replace(/ят$/, 'я')}` });
  }
  // Прилагателно с пълен член пред съществително с кратък: „големият магазин“ е подлог, „на големия магазин“ — не; хваща „на големият“.
  if (spell) {
    // Редните числа („13-ият“, „2-ра“) и съкращенията с точка („ул.“, „напр.“) не са думи за речника.
    const words = text.replace(/\d+-[А-Яа-я]+/g, ' ').match(/[А-Яа-яЀ-ӿ]+(?:-[А-Яа-яЀ-ӿ]+)*/g) || [];
    for (const w of words) {
      if (w.length < 2 || ignore.has(w.toLowerCase())) continue;
      if (/^[А-ЯЀ-Я]{2,}$/.test(w)) continue; // съкращения: ДДС, НАП, БАБХ
      const parts = w.split('-');
      if (parts.every((p) => spell.correct(p) || spell.correct(p.toLowerCase()) || ignore.has(p.toLowerCase()) || p === 'по' || p === 'най')) continue;
      hits.push({ rule: 'rechnik', msg: 'няма я в речника — грешка, или име/термин за ignore', at: w, fix: (spell.suggest(w) || []).slice(0, 3).join(', ') || '—', soft: true });
    }
  }
  return hits;
}

// ---------- обхождането ----------
function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p)) if (!SKIP_DIRS.has(f) && !f.startsWith('.')) walk(path.join(p, f), out);
  } else if (EXT.has(path.extname(p).toLowerCase()) && !/\.min\.js$|package-lock|\.map$/.test(p)) out.push(p);
}

const spell = await loadSpell();
const ignore = loadIgnore();
const report = [];
for (const t of targets) {
  if (/^https?:\/\//.test(t)) {
    const html = await (await fetch(t)).text();
    for (const pc of extract('x.html', html)) for (const h of checkPiece(pc.text, spell, ignore)) report.push({ file: t, line: pc.line, ...h });
    continue;
  }
  const files = []; walk(t, files);
  for (const f of files) {
    const pieces = f.endsWith('.docx')
      ? docxText(fs.readFileSync(f)).split('\n').map((text, i) => ({ line: i + 1, text })).filter((x) => CYR.test(x.text))
      : extract(f, fs.readFileSync(f, 'utf8'));
    for (const pc of pieces) for (const h of checkPiece(pc.text, spell, ignore)) report.push({ file: f, line: pc.line, ...h });
  }
}

// Една и съща непозната дума се показва веднъж, с броя.
const seen = new Map();
const final = [];
for (const r of report) {
  if (r.rule === 'rechnik') {
    const k = r.at.toLowerCase();
    if (seen.has(k)) { seen.get(k).count++; continue; }
    r.count = 1; seen.set(k, r);
  }
  final.push(r);
}

if (flag('--json')) { console.log(JSON.stringify(final, null, 1)); process.exit(0); }
const hard = final.filter((r) => !r.soft), soft = final.filter((r) => r.soft);
for (const r of hard) console.log(`${r.file}:${r.line}  [${r.rule}] ${r.msg}\n    „…${r.at}…“  →  ${r.fix}`);
if (soft.length) {
  console.log(`\n— За преглед (речник и стил), ${soft.length}:`);
  for (const r of soft) console.log(`${r.file}:${r.line}  [${r.rule}] ${r.at}${r.count > 1 ? ` (×${r.count})` : ''}  →  ${r.fix}`);
}
console.log(`\n${hard.length} правописни · ${soft.length} за преглед`);

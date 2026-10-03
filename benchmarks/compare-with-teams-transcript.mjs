#!/usr/bin/env node
/**
 * So sánh transcript của app với transcript Teams của cùng buổi họp và in ra
 * 5 con số để theo dõi tiến bộ giữa các buổi:
 *
 *   1. Độ phủ theo người nói   — % dòng Teams (có nội dung) tìm thấy trong app
 *   2. Tên riêng / thuật ngữ   — % dòng Teams chứa term mà app cũng nghe ra term đó
 *   3. Nhãn người nói          — độ "thuần" của nhãn Speaker N so với tên Teams
 *   4. Tỉ lệ dòng đệm          — % segment của app chỉ là うん / はい / そうですね…
 *   5. Actions                 — số action trong tóm tắt có người thật + có ticket
 *
 * Ghép dòng: thời gian ±window (mặc định 25 s, sau khi tự dò offset giữa đồng
 * hồ Teams và đồng hồ app) và chung ≥ 2 cụm 5 ký tự. Không gọi mạng, không
 * phụ thuộc gói ngoài.
 *
 * Dùng:
 *   node benchmarks/compare-with-teams-transcript.mjs \
 *     --teams original-ja.md|.vtt  --app original-vi.md|session.md \
 *     [--terms terms.txt] [--roster roster.txt] [--window 25] [--offset SEC] [--json out.json]
 */
import fs from 'node:fs';

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (!args.teams || !args.app) {
    console.error('Cần --teams <file> và --app <file>. Xem phần đầu file để biết các cờ khác.');
    process.exit(2);
}
const WINDOW = Number(args.window ?? 25);
const FILLER_RE = /^(?:うん|ううん|うーん|はい|はーい|ええ|えー|え|あ|あー|あっ|お|おー|ん|んー|そう|そうそう|そうですね|そうですよね|なるほど|ふーん|へー|ほう|そっか|okay|ok|yes|yeah|mm|hmm|ok)+$/;
const MIN_SUBSTANTIVE = 6; // ký tự sau chuẩn hoá; ngắn hơn coi là đệm, không tính độ phủ

const teams = parseTeams(fs.readFileSync(args.teams, 'utf8'));
const app = parseApp(fs.readFileSync(args.app, 'utf8'));
const terms = args.terms ? readList(args.terms) : [];
const roster = args.roster ? readRoster(args.roster) : [];

if (!teams.lines.length) die(`Không đọc được dòng nào từ ${args.teams}`);
if (!app.segments.length) die(`Không đọc được segment nào từ ${args.app}`);

// ─── Alignment ───────────────────────────────────────────────────────────────
const appIndex = buildNgramIndex(app.segments);
const offset = args.offset != null ? Number(args.offset) : estimateOffset(teams.lines, app.segments, appIndex);
const matches = matchLines(teams.lines, app.segments, appIndex, offset, WINDOW);

// ─── 1. Coverage per speaker ─────────────────────────────────────────────────
const coverage = {};
for (const line of teams.lines) {
    if (!line.substantive) continue;
    const c = (coverage[line.speaker] ??= { total: 0, matched: 0 });
    c.total++;
    if (matches.has(line.id)) c.matched++;
}
const covTotal = sum(Object.values(coverage), (c) => c.total);
const covMatched = sum(Object.values(coverage), (c) => c.matched);

// ─── 2. Term accuracy on matched pairs ───────────────────────────────────────
const termStats = terms.map((term) => {
    const nt = norm(term);
    let inTeams = 0, matchedLines = 0, hits = 0;
    for (const line of teams.lines) {
        if (!line.norm.includes(nt)) continue;
        inTeams++;
        const m = matches.get(line.id);
        if (!m) continue;
        matchedLines++;
        if (m.seg.norm.includes(nt)) hits++;
    }
    const inApp = app.segments.filter((s) => s.norm.includes(nt)).length;
    return { term, inTeams, inApp, matchedLines, hits };
});
const termsWithData = termStats.filter((t) => t.matchedLines > 0);
const termHits = sum(termsWithData, (t) => t.hits);
const termDenom = sum(termsWithData, (t) => t.matchedLines);

// ─── 3. Speaker-label purity ─────────────────────────────────────────────────
const contingency = {}; // label → name → count
for (const [lineId, m] of matches) {
    const line = teams.byId.get(lineId);
    const label = m.seg.speaker || '(không nhãn)';
    ((contingency[label] ??= {})[line.speaker] ??= 0);
    contingency[label][line.speaker]++;
}
let purityNum = 0, purityDen = 0;
const labelRows = Object.entries(contingency).map(([label, byName]) => {
    const entries = Object.entries(byName).sort((a, b) => b[1] - a[1]);
    const total = sum(entries, (e) => e[1]);
    purityNum += entries[0][1];
    purityDen += total;
    return { label, total, top: entries.slice(0, 3) };
}).sort((a, b) => b.total - a.total);

// ─── 4. Filler rate ──────────────────────────────────────────────────────────
const fillerCount = app.segments.filter((s) => isFiller(s.norm)).length;

// ─── 5. Actions ──────────────────────────────────────────────────────────────
const actionRows = app.actions.map((a) => {
    const parts = a.split(/\s+·\s+/);
    const assignee = parts[1] || '';
    const realPerson = roster.find((r) => r.variants.some((v) => assignee.includes(v)));
    const ticket = /(?:NOD_DEV_2017-|#)?\b(2[0-9]{3})\b/.exec(a);
    return { text: a, assignee, realPerson: realPerson?.canonical || null, ticket: ticket?.[1] || null };
});
const actWithPerson = actionRows.filter((a) => a.realPerson).length;
const actWithTicket = actionRows.filter((a) => a.ticket).length;
const actWithBoth = actionRows.filter((a) => a.realPerson && a.ticket).length;

// ─── Report ──────────────────────────────────────────────────────────────────
const out = [];
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a');
out.push(`# So sánh app ↔ Teams`);
out.push('');
out.push(`- Teams: \`${args.teams}\` — ${teams.lines.length} dòng, ${covTotal} dòng có nội dung (≥ ${MIN_SUBSTANTIVE} ký tự)`);
out.push(`- App: \`${args.app}\` — ${app.segments.length} segment${app.format ? ` (định dạng: ${app.format})` : ''}`);
out.push(`- Offset đồng hồ app − Teams: ${offset.toFixed(0)} s${args.offset != null ? ' (ép bằng --offset)' : ' (tự dò)'} · cửa sổ ghép ±${WINDOW} s`);
out.push('');
out.push(`## Tóm tắt 5 số`);
out.push('');
out.push(`| # | Chỉ số | Giá trị |`);
out.push(`|---|---|---|`);
out.push(`| 1 | Độ phủ dòng Teams có nội dung | **${pct(covMatched, covTotal)}** (${covMatched}/${covTotal}) |`);
out.push(`| 2 | Tên riêng / thuật ngữ nghe đúng | **${pct(termHits, termDenom)}** (${termHits}/${termDenom} dòng đã ghép có term${terms.length ? '' : ' — chưa truyền --terms'}) |`);
out.push(`| 3 | Độ thuần nhãn người nói | **${pct(purityNum, purityDen)}** (${Object.keys(contingency).length} nhãn cho ${Object.keys(coverage).length} người) |`);
out.push(`| 4 | Tỉ lệ segment đệm | **${pct(fillerCount, app.segments.length)}** (${fillerCount}/${app.segments.length}) |`);
out.push(`| 5 | Actions có người thật / có ticket / cả hai | **${actWithPerson} / ${actWithTicket} / ${actWithBoth}** trên ${actionRows.length}${roster.length ? '' : ' — chưa truyền --roster'} |`);
out.push('');
out.push(`## 1. Độ phủ theo người nói`);
out.push('');
out.push(`| Người (Teams) | Dòng có nội dung | Tìm thấy trong app | Độ phủ |`);
out.push(`|---|---|---|---|`);
for (const [name, c] of Object.entries(coverage).sort((a, b) => b[1].total - a[1].total)) {
    out.push(`| ${name} | ${c.total} | ${c.matched} | ${pct(c.matched, c.total)} |`);
}
out.push('');
if (terms.length) {
    out.push(`## 2. Thuật ngữ (chỉ liệt kê term xuất hiện trong Teams)`);
    out.push('');
    out.push(`| Term | Lần trong Teams | Lần trong app | Dòng ghép có term | App nghe đúng | Tỉ lệ |`);
    out.push(`|---|---|---|---|---|---|`);
    for (const t of termStats.filter((t) => t.inTeams > 0).sort((a, b) => b.inTeams - a.inTeams)) {
        out.push(`| ${t.term} | ${t.inTeams} | ${t.inApp} | ${t.matchedLines} | ${t.hits} | ${pct(t.hits, t.matchedLines)} |`);
    }
    out.push('');
}
out.push(`## 3. Nhãn người nói → ai thật sự nói (theo cặp đã ghép)`);
out.push('');
out.push(`| Nhãn app | Số cặp | Top 3 người thật |`);
out.push(`|---|---|---|`);
for (const r of labelRows) {
    out.push(`| ${r.label} | ${r.total} | ${r.top.map(([n, c]) => `${n} ${c}`).join(' · ')} |`);
}
out.push('');
out.push(`## 5. Actions trong tóm tắt`);
out.push('');
if (!actionRows.length) out.push('_Không tìm thấy khối ACTIONS trong file app._');
for (const a of actionRows) {
    const flags = [a.realPerson ? `👤 ${a.realPerson}` : '— không rõ người', a.ticket ? `🎫 ${a.ticket}` : '— không ticket'];
    out.push(`- ${a.text}  \n  ${flags.join(' · ')}`);
}
out.push('');
if (args['show-pairs']) {
    // Kiểm tra bằng mắt xem phép ghép có đáng tin không: in vài cặp đã ghép
    // (rải đều theo thời gian) và vài dòng Teams có nội dung mà app không có.
    const n = Number(args['show-pairs']) || 8;
    const matched = [...matches.entries()];
    const step = Math.max(1, Math.floor(matched.length / n));
    out.push('## Kiểm tra ghép (mẫu)');
    out.push('');
    for (let i = 0; i < matched.length && out.length < 10_000; i += step) {
        const [id, m] = matched[i];
        const l = teams.byId.get(id);
        out.push(`- Teams [${fmt(l.t)}] ${l.speaker}: ${l.text}`);
        out.push(`  App  [${fmt(m.seg.t)}] ${m.seg.speaker || '?'} (Δ${m.dt.toFixed(0)}s, dice ${(m.score).toFixed(2)}): ${m.seg.src}`);
    }
    out.push('');
    out.push('### Dòng Teams có nội dung, app không có (mẫu)');
    out.push('');
    const missed = teams.lines.filter((l) => l.substantive && !matches.has(l.id));
    const ms = Math.max(1, Math.floor(missed.length / n));
    for (let i = 0; i < missed.length; i += ms) {
        const l = missed[i];
        out.push(`- [${fmt(l.t)}] ${l.speaker}: ${l.text}`);
    }
    out.push('');
}
console.log(out.join('\n'));

function fmt(sec) {
    const s = Math.round(sec);
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':');
}

if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({
        teams: args.teams, app: args.app, offset, window: WINDOW,
        coverage: { total: covTotal, matched: covMatched, bySpeaker: coverage },
        terms: { hits: termHits, denom: termDenom, detail: termStats },
        speakerPurity: { num: purityNum, den: purityDen, labels: labelRows },
        filler: { count: fillerCount, total: app.segments.length },
        actions: { total: actionRows.length, withPerson: actWithPerson, withTicket: actWithTicket, withBoth: actWithBoth, rows: actionRows },
    }, null, 2));
}

// ─── Parsers ─────────────────────────────────────────────────────────────────
function parseTeams(text) {
    const lines = [];
    if (/^WEBVTT/m.test(text)) {
        // VTT: "HH:MM:SS.mmm --> HH:MM:SS.mmm" rồi "<v Tên>nội dung</v>"
        const blocks = text.split(/\r?\n\r?\n/);
        for (const b of blocks) {
            const tm = /(\d+):(\d\d):(\d\d)[.,](\d+)\s*-->/.exec(b);
            const vm = /<v\s+([^>]+)>([\s\S]*?)(?:<\/v>|$)/.exec(b);
            if (!tm || !vm) continue;
            push(lines, hms(tm[1], tm[2], tm[3]), vm[1].trim(), vm[2].replace(/<[^>]+>/g, '').trim());
        }
    } else {
        // Markdown xuất từ Teams/Stream: **[m:ss] Tên:** nội dung  (hoặc [h:mm:ss])
        const re = /^\*\*\[(?:(\d+):)?(\d+):(\d\d)\]\s*([^:*]+?):\*\*\s*(.*)$/;
        for (const raw of text.split(/\r?\n/)) {
            const m = re.exec(raw.trim());
            if (!m) continue;
            push(lines, hms(m[1] || 0, m[2], m[3]), m[4].trim(), m[5].trim());
        }
    }
    const byId = new Map(lines.map((l) => [l.id, l]));
    return { lines, byId };

    function push(arr, t, speaker, text) {
        const n = norm(text);
        arr.push({ id: arr.length, t, speaker, text, norm: n, substantive: n.length >= MIN_SUBSTANTIVE && !isFiller(n) });
    }
}

function parseApp(text) {
    const segments = [];
    const actions = [];
    let format = null;
    let speaker = null;
    let pending = null; // segment chờ dòng "> ja" / "→ tgt"
    let inActions = false;

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();

        // ── khối ACTIONS trong "## Tóm tắt"
        if (/^ACTIONS:\s*$/.test(line.trim())) { inActions = true; continue; }
        if (inActions) {
            if (/^-\s+/.test(line.trim())) { actions.push(line.trim().replace(/^-\s+/, '')); continue; }
            if (line.trim() === '' && actions.length) { inActions = false; }
            else if (/^#|^[A-ZĐ ]+:$/.test(line.trim())) inActions = false;
            if (inActions) continue;
        }

        let m;
        if ((m = /^\*\*(Speaker\s+\d+|[^*]+)\*\*\s*$/.exec(line.trim()))) {
            speaker = m[1].trim();
            format ??= 'note (Speaker N / [hh:mm:ss] vi / > ja)';
            continue;
        }
        if ((m = /^\[(\d\d):(\d\d):(\d\d)\]\s*(.*)$/.exec(line.trim()))) {
            pending = { id: segments.length, t: hms(m[1], m[2], m[3]), speaker, tgt: m[4].trim(), src: '' };
            segments.push(pending);
            continue;
        }
        if (pending && (m = /^(?:>|→)\s*(.*)$/.exec(line.trim()))) {
            if (line.trim().startsWith('>')) {
                pending.src = m[1].trim();                 // note: "> ja"
            } else {
                // session .md: "[ts] src" rồi "→ tgt" — dòng [ts] là NGUỒN
                format ??= 'session ([hh:mm:ss] src / → tgt)';
                pending.src = pending.tgt;
                pending.tgt = m[1].trim();
            }
            pending = null;
            continue;
        }
    }
    for (const s of segments) {
        s.norm = norm(s.src || '');
    }
    return { segments, actions, format };
}

// ─── Matching ────────────────────────────────────────────────────────────────
function ngrams(s, n = 5) {
    const out = new Set();
    for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
    return out;
}

function buildNgramIndex(segments) {
    const idx = new Map();
    for (const seg of segments) {
        seg.grams = ngrams(seg.norm);
        for (const g of seg.grams) (idx.get(g) ?? idx.set(g, []).get(g)).push(seg.id);
    }
    return idx;
}

function candidates(line, segments, idx) {
    const shared = new Map();
    for (const g of ngrams(line.norm)) {
        for (const id of idx.get(g) || []) shared.set(id, (shared.get(id) || 0) + 1);
    }
    const need = Math.min(2, Math.max(1, line.norm.length - 4));
    return [...shared].filter(([, c]) => c >= need).map(([id, c]) => ({ seg: segments[id], shared: c }));
}

/** Offset = mode của (t_app − t_teams) trên các cặp có chung ≥2 cụm 5 ký tự. */
function estimateOffset(lines, segments, idx) {
    const buckets = new Map();
    const BUCKET = 5;
    for (const line of lines) {
        if (!line.substantive) continue;
        for (const c of candidates(line, segments, idx)) {
            if (c.shared < 2) continue;
            const d = Math.round((c.seg.t - line.t) / BUCKET);
            buckets.set(d, (buckets.get(d) || 0) + 1);
        }
    }
    if (!buckets.size) die('Không dò được offset: hai file không có câu nào giống nhau. Dùng --offset.');
    const [best] = [...buckets].sort((a, b) => b[1] - a[1])[0];
    // tinh chỉnh: trung vị các delta trong ±30 s quanh mode
    const deltas = [];
    for (const line of lines) {
        if (!line.substantive) continue;
        for (const c of candidates(line, segments, idx)) {
            const d = c.seg.t - line.t;
            if (Math.abs(d - best * BUCKET) <= 30) deltas.push(d);
        }
    }
    deltas.sort((a, b) => a - b);
    return deltas[Math.floor(deltas.length / 2)];
}

function matchLines(lines, segments, idx, offset, window) {
    const matches = new Map();
    for (const line of lines) {
        if (!line.substantive) continue;
        let best = null;
        for (const c of candidates(line, segments, idx)) {
            const dt = Math.abs(c.seg.t - (line.t + offset));
            if (dt > window) continue;
            const score = dice(line.norm, c.seg.norm) - dt / (window * 20);
            if (!best || score > best.score) best = { seg: c.seg, score, dt };
        }
        if (best) matches.set(line.id, best);
    }
    return matches;
}

function dice(a, b) {
    const A = ngrams(a, 2), B = ngrams(b, 2);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size);
}

// ─── Text helpers ────────────────────────────────────────────────────────────
function norm(s) {
    return s
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s、。，．,.？?！!…「」『』（）()\[\]【】〈〉《》"'“”‘’・ー—–\-~〜:：;；]/g, '');
}

function isFiller(n) {
    return n.length === 0 || n.length <= 2 || FILLER_RE.test(n);
}

function hms(h, m, s) {
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function readList(file) {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function readRoster(file) {
    return readList(file).map((l) => {
        const variants = l.split('|').map((v) => v.trim()).filter(Boolean);
        return { canonical: variants[0], variants };
    });
}

function sum(arr, f) {
    return arr.reduce((a, x) => a + f(x), 0);
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next == null || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i++; }
    }
    return out;
}

function die(msg) {
    console.error(msg);
    process.exit(1);
}

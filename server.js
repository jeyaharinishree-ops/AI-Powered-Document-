const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Ajv = require('ajv');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const MAX_CHARS = 20000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- Predefined JSON schema (validated with Ajv) ----------
const nullableStr = { type: ['string', 'null'] };
const SCHEMA = { type: 'object', required: ['summary', 'key_findings', 'extracted', 'completeness'], properties: {
  summary: { type: 'string' }, key_findings: { type: 'array', items: { type: 'string' } },
  extracted: { type: 'object', required: ['name', 'email', 'phone', 'skills', 'education', 'experience'], properties: {
    name: nullableStr, email: nullableStr, phone: nullableStr, skills: { type: 'array', items: { type: 'string' } },
    education: { type: 'array', items: { type: 'object', required: ['degree', 'institution', 'year'], properties: { degree: nullableStr, institution: nullableStr, year: nullableStr } } },
    experience: { type: 'array', items: { type: 'object', required: ['title', 'company', 'duration', 'highlights'], properties: { title: nullableStr, company: nullableStr, duration: nullableStr, highlights: { type: 'array', items: { type: 'string' } } } } } } },
  completeness: { type: 'object', required: ['score'], properties: { score: { type: 'number', minimum: 0, maximum: 100 } } } } };
const checkSchema = new Ajv().compile(SCHEMA);
const LIMITS = { basic: { hl: 0, kf: 3, phone: false }, standard: { hl: 2, kf: 5, phone: false }, detailed: { hl: 5, kf: 8, phone: true } };

// ---------- 1. Text extraction ----------
async function extractText(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') {
    const data = await pdfParse(file.buffer);
    return data.text;
  }
  if (name.endsWith('.txt') || file.mimetype.startsWith('text/')) return file.buffer.toString('utf8');
  const e = new Error('Unsupported file type. Please upload a PDF or TXT file.'); e.status = 415; throw e;
}

// ---------- 2. Prompt (adaptive by level / style / focus) ----------
const LEVELS = {
  basic: 'Extract only name, email, skills and education. Leave experience highlights empty. Give 3 key findings.',
  standard: 'Extract all fields. Give up to 2 highlights per job. Give 5 key findings.',
  detailed: 'Extract all fields including phone. Give up to 5 highlights per job, and 8 key findings with evidence from the text.'
};
const STYLES = {
  brief: 'Summary: 2-3 sentences, plain prose.',
  detailed: 'Summary: 2-3 paragraphs separated by \\n\\n covering profile, strengths and gaps.',
  bullets: 'Summary: 5-8 bullet lines, each starting with "- ", separated by \\n.'
};
function buildPrompt(text, level, style, focus, jd) {
  return `You are a careful resume analyst. Use ONLY the resume text below. Never invent details. If something is not in the text, use null (or [] for lists).
Analysis level: ${LEVELS[level]}
${STYLES[style]}
${focus.length ? 'Focus especially on: ' + focus.join(', ') + '. Mention these prominently in summary and key_findings.' : ''}
Return ONLY JSON in this exact shape:
{"summary": string,
 "key_findings": [string],
 "extracted": {"name": string|null, "email": string|null, "phone": string|null, "skills": [string],
   "education": [{"degree": string|null, "institution": string|null, "year": string|null}],
   "experience": [{"title": string|null, "company": string|null, "duration": string|null, "highlights": [string]}]},
 "skill_categories": {"<category name>": [skills from the list above]},
 "uncertain_fields": [string]${jd ? ',\n "job_match": {"score": number 0-100, "matched_skills": [string], "missing_skills": [string], "advice": [string, max 3 concrete resume improvements]}' : ''}}
List in uncertain_fields any field you are unsure about.

${jd ? 'Also compare the resume with this job description. Only count skills truly present in the resume as matched.\nJOB DESCRIPTION:\n"""' + jd + '"""\n' : ''}
RESUME:
"""${text}"""`;
}

// ---------- 3. LLM call ----------
async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { const e = new Error('Server is missing GEMINI_API_KEY.'); e.status = 500; throw e; }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } })
  });
  if (!res.ok) { const e = new Error('AI service error (' + res.status + '). Try again shortly.'); e.status = 502; throw e; }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

// ---------- 4. Validation + grounding ----------
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const arr = v => (Array.isArray(v) ? v : []);
function validate(out, source, level, jd) {
  const L = LIMITS[level];
  const lower = source.toLowerCase();
  const notes = [];
  const x = out.extracted || {};
  const email = str(x.email);
  const emailOk = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && lower.includes(email.toLowerCase());
  if (email && !emailOk) notes.push('Email removed: not found in the document.');
  const name = str(x.name);
  const nameOk = name && lower.includes(name.toLowerCase().split(' ')[0]);
  if (name && !nameOk) notes.push('Name removed: could not be verified in the document.');
  const skills = arr(x.skills).map(str).filter(Boolean);
  const grounded = skills.filter(s => lower.includes(s.toLowerCase()));
  if (grounded.length < skills.length) notes.push(`${skills.length - grounded.length} skill(s) dropped: not present in the text.`);
  const education = arr(x.education).map(e => ({ degree: str(e?.degree), institution: str(e?.institution), year: str(e?.year) }))
    .filter(e => e.degree || e.institution);
  const experience = arr(x.experience).map(e => ({ title: str(e?.title), company: str(e?.company), duration: str(e?.duration),
    highlights: arr(e?.highlights).map(str).filter(Boolean).slice(0, L.hl) })).filter(e => e.title || e.company);
  const cats = {};
  for (const [c, list] of Object.entries(out.skill_categories || {})) {
    const keep = arr(list).filter(s => grounded.map(g => g.toLowerCase()).includes(String(s).toLowerCase()));
    if (keep.length) cats[c] = keep;
  }
  const extracted = { name: nameOk ? name : null, email: emailOk ? email : null, phone: L.phone ? str(x.phone) : null, skills: grounded, education, experience };
  // Completeness: weighted rules
  const rules = [['Name', 15, !!extracted.name], ['Email', 20, !!extracted.email], ['Skills', 25, grounded.length > 0],
    ['Education', 20, education.length > 0], ['Work experience', 20, experience.length > 0]];
  const score = rules.reduce((s, r) => s + (r[2] ? r[1] : 0), 0);
  let job_match = null;
  if (jd && out.job_match) {
    const g = grounded.map(k => k.toLowerCase());
    const jm = out.job_match;
    const matched = arr(jm.matched_skills).map(str).filter(k => k && g.includes(k.toLowerCase()));
    job_match = { score: Math.max(0, Math.min(100, Math.round(Number(jm.score) || 0))), matched_skills: matched,
      missing_skills: arr(jm.missing_skills).map(str).filter(Boolean), advice: arr(jm.advice).map(str).filter(Boolean).slice(0, 3) };
  }
  return { job_match, summary: str(out.summary) || 'No summary could be generated.', key_findings: arr(out.key_findings).map(str).filter(Boolean).slice(0, L.kf),
    extracted, skill_categories: cats, uncertain_fields: arr(out.uncertain_fields).map(str).filter(Boolean),
    completeness: { score, checks: rules.map(r => ({ field: r[0], weight: r[1], present: r[2] })) }, validation_notes: notes };
}

// ---------- Routes ----------
app.get('/api/samples', (_, res) => res.json(fs.readdirSync(path.join(__dirname, 'samples')).filter(f => /\.(txt|pdf)$/.test(f))));

app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    const level = LEVELS[req.body.level] ? req.body.level : 'standard';
    const style = STYLES[req.body.style] ? req.body.style : 'brief';
    const focus = (req.body.focus || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
    let file = req.file;
    if (!file && req.body.sample) {
      const p = path.join(__dirname, 'samples', path.basename(req.body.sample));
      if (!fs.existsSync(p)) return res.status(404).json({ error: 'Sample not found.' });
      file = { originalname: path.basename(p), mimetype: p.endsWith('.pdf') ? 'application/pdf' : 'text/plain', buffer: fs.readFileSync(p) };
    }
    if (!file) return res.status(400).json({ error: 'Please upload a file or pick a sample.' });
    let text;
    try { text = (await extractText(file)).replace(/\s+\n/g, '\n').trim(); }
    catch (e) { if (e.status) throw e; const err = new Error('This file could not be read. It may be corrupted or password-protected.'); err.status = 422; throw err; }
    if (text.length < 40) return res.status(422).json({ error: 'No readable text found. Scanned/image-only PDFs are not supported.' });
    const jd = (req.body.jd || '').trim().slice(0, 4000);
    const llm = await callGemini(buildPrompt(text.slice(0, MAX_CHARS), level, style, focus, jd));
    const result = validate(llm, text, level, jd);
    if (!checkSchema(result)) { console.error(checkSchema.errors); return res.status(502).json({ error: 'AI output failed schema validation. Please retry.' }); }
    res.json({ ...result, schema_valid: true, source_text: text.slice(0, MAX_CHARS), meta: { level, style, focus, chars: text.length, truncated: text.length > MAX_CHARS } });
  } catch (e) {
    console.error(e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not analyze the document. Please try again.' });
  }
});

app.use((err, req, res, next) => res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB.' : 'Upload failed.' }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Running on http://localhost:' + port));

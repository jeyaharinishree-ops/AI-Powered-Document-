# Resume Lens - AI-Powered Document Intelligence (Task 2)

Upload a resume (PDF/TXT) and get an AI summary, validated structured JSON, a completeness score and a skills chart.

## Tech
Node.js 18+, Express, Multer (upload), pdf-parse (text extraction), vanilla HTML/CSS/JS frontend.
**AI:** Google Gemini via Google AI Studio free tier (`gemini-flash-latest`, JSON output mode). No other paid service.

## Setup
```bash
npm install
cp .env.example .env     # add your key; or export it in your shell
GEMINI_API_KEY=your_key npm start
```
Open http://localhost:3000.

## Environment variables
| Name | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | Google AI Studio key |
| `GEMINI_MODEL` | no | default `gemini-flash-latest` |
| `PORT` | no | default 3000 |

## Deploy on Render (free)
Push to GitHub > Render > New Web Service > pick repo (render.yaml is included) > add `GEMINI_API_KEY` under Environment > Deploy.

## Unique features
- **Evidence view:** the original text is shown with every extracted value highlighted, so each field can be traced to its source.
- **Job match (optional):** paste a job description to get a match score, matched/missing skills and 3 concrete resume fixes (matched skills are verified against the resume text).
- **Schema-validated JSON** (Ajv) with a one-click JSON download.
- **Level enforcement in code:** Basic hides phone/highlights, Standard limits highlights, Detailed shows all, independent of the model's output.

## How to test
1. Pick `sample_resume_1.txt`, select **Analyze resume**: expect high completeness.
2. Pick `sample_resume_2.txt`: email/phone/experience show as **Missing** (null), completeness drops.
3. Switch Analysis level (Basic/Standard/Detailed) and Summary style, re-run, and compare depth.
4. Try sample_resume_4.pdf and sample_resume_5.pdf (anonymized real-style resumes; the second has no work experience or institution, so completeness is lower).
5. Add "Python, projects" in Focus: summary and findings emphasise them.
6. Upload an empty or image-only PDF, or a .docx: friendly error messages appear.

## Logic
- **Extraction:** pdf-parse for PDFs, UTF-8 for TXT; <40 characters = rejected as unreadable.
- **Analysis levels:** the level changes the prompt instructions: Basic (name, email, skills, education), Standard (all fields, 2 highlights/job), Detailed (adds phone, 5 highlights/job, 8 findings). Style (brief/detailed/bullets) and optional focus topics are added to the same prompt.
- **Structured output:** Gemini JSON mode with a fixed schema; the server then validates types and shape.
- **Grounding/validation:** email must match a regex AND appear in the source text; name's first token must appear; skills not found in the source are dropped; empty values become `null`. Removals are shown to the user as notes. `uncertain_fields` from the model is shown as "Please review".
- **Completeness score:** Name 15, Email 20, Skills 25, Education 20, Experience 20 (points when present).
- **Visual:** skill categories (from the LLM, filtered to grounded skills) drawn as bars, plus a score ring. No image API needed, so it is fast and reliable.

## Known limitations
- Scanned/image-only PDFs need OCR (not included). Only the first 20,000 characters are analysed.
- Single resume type; DOCX unsupported. Free-tier API rate limits may apply.
- Substring grounding check is simple; unusual skill spellings may be dropped.

import 'dotenv/config'
import express from 'express'
import path from 'path'
import OpenAI from 'openai'
import { AgentGuard } from './agentguard-sdk'

const required = ['OPENAI_API_KEY', 'AGENTGUARD_API_KEY', 'AGENTGUARD_AGENT_ID']
const missing = required.filter((k) => !process.env[k])
if (missing.length) {
  console.error(`❌  Missing env vars: ${missing.join(', ')}`)
  console.error('    Copy .env.example → .env and fill in the values.')
  process.exit(1)
}

// ── AgentGuard SDK — the only governance-specific code ─────────────────────
const guard = new AgentGuard({
  apiKey: process.env.AGENTGUARD_API_KEY!,
  agentId: process.env.AGENTGUARD_AGENT_ID!,
})
const openai = guard.wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }))
// ──────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Regulatory Compliance AI for Acme Bank, specialising in GCC banking regulations.

Analyse the provided policy or procedure text against the specified regulatory framework and return ONLY a valid JSON object — no markdown, no explanation outside JSON.

JSON schema:
{
  "compliance_status": "COMPLIANT" | "PARTIALLY_COMPLIANT" | "NON_COMPLIANT" | "REQUIRES_REVIEW",
  "overall_score": <integer 0-100>,
  "gaps": [
    {
      "requirement": "<regulation clause or requirement>",
      "finding": "<what is missing or incorrect>",
      "severity": "CRITICAL" | "MAJOR" | "MINOR",
      "recommendation": "<specific corrective action>"
    }
  ],
  "compliant_areas": ["<requirement that is satisfied>"],
  "immediate_actions": ["<action required before next regulatory review>"],
  "review_recommendation": "<suggested timeline and scope for next review>"
}

Supported frameworks: CBUAE, SAMA, AML/CFT (FATF), Basel III/IV, UAE PDPL, PCI-DSS.
Be precise — cite specific articles, circulars, or guideline numbers where applicable.`

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim()
}

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

app.post('/api/check', async (req, res) => {
  const { document, regulation } = req.body as { document?: string; regulation?: string }

  if (!document?.trim() || !regulation?.trim()) {
    res.status(400).json({ error: 'Document text and regulation framework are required.' })
    return
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Regulation Framework: ${regulation}\n\nPolicy/Procedure to check:\n${document.trim()}`,
        },
      ],
      max_tokens: 800,
      temperature: 0.1,
    })

    const raw = stripCodeFences(response.choices[0]?.message?.content ?? '{}')
    const result = JSON.parse(raw)
    res.json(result)
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err)
    res.status(500).json({ error: 'Compliance check failed. Please try again.' })
  }
})

const PORT = parseInt(process.env.PORT ?? '3002', 10)
app.listen(PORT, () => {
  console.log(`\n📋  Acme Bank — Regulatory Compliance Checker`)
  console.log(`    URL:        http://localhost:${PORT}`)
  console.log(`    Model:      gpt-4o`)
  console.log(`    Governed by AgentGuard ✓\n`)
})
